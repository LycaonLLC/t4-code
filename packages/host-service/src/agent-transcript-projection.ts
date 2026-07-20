import { createHash } from "node:crypto";
import type {
	AgentTranscriptFrame,
	ArtifactDescriptor,
	DurableEntry,
	EntryId,
	HostId,
	Revision,
	SessionId,
	TranscriptImageMetadata,
} from "@t4-code/host-wire";
import {
	decodeArtifactDescriptorList,
	decodeTranscriptImageMetadataList,
	agentId as wireAgentId,
} from "@t4-code/host-wire";
import type { RpcSubagentMessagesResult } from "./omp-rpc-contract.ts";
import { SessionEntryProjector } from "./discovery.ts";

const MAX_RETAINED_ENTRIES = 512;
const MAX_RETAINED_BYTES = 384 * 1024;
const MAX_RETAINED_IMAGE_ENTRIES = 512;
const MAX_RETAINED_AGENTS = 256;
const MAX_DRAIN_READS = 8;
const encoder = new TextEncoder();
const ENTRY_FIELD_OMITTED = "Field exceeded the agent transcript display budget.";
const ENTRY_DATA_OMITTED = "Entry data exceeded the agent transcript display budget.";

export interface AgentTranscriptProjectionOptions {
	readonly hostId: HostId;
	readonly sessionId: SessionId;
	readonly epoch: string;
	readonly read: (agentId: string, fromByte: number) => Promise<RpcSubagentMessagesResult>;
	readonly revision: () => Revision;
	readonly emit: (frame: AgentTranscriptFrame) => void;
	readonly artifactResolver?: (id: string) => ArtifactDescriptor | undefined;
}

interface AgentTranscriptState {
	readonly agentId: string;
	projector: SessionEntryProjector;
	fromByte: number;
	generation: number;
	seq: number;
	retained: DurableEntry[];
	retainedBytes: number;
	imageAuthorizations: Map<EntryId, TranscriptImageMetadata[]>;
	queued: boolean;
	inFlight: boolean;
}

function entryBytes(entry: DurableEntry): number {
	return encoder.encode(JSON.stringify(entry)).byteLength;
}

function transcriptEpoch(root: string, agentId: string, generation: number): string {
	const digest = createHash("sha256").update(agentId).digest("hex").slice(0, 16);
	return `${root}:agent:${digest}:${generation}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function withEntryData(entry: DurableEntry, data: Record<string, unknown>): DurableEntry {
	return { ...entry, data };
}

function boundedEntry(entry: DurableEntry): DurableEntry {
	if (entryBytes(entry) <= MAX_RETAINED_BYTES) return entry;

	let data = { ...entry.data };
	let result = record(data.result);
	if (result && Object.hasOwn(result, "details")) {
		result = { ...result, details: { omitted: ENTRY_FIELD_OMITTED } };
		data = { ...data, result };
		const candidate = withEntryData(entry, data);
		if (entryBytes(candidate) <= MAX_RETAINED_BYTES) return candidate;
	}
	if (Object.hasOwn(data, "args")) {
		data = { ...data, args: { omitted: ENTRY_FIELD_OMITTED } };
		const candidate = withEntryData(entry, data);
		if (entryBytes(candidate) <= MAX_RETAINED_BYTES) return candidate;
	}
	result = record(data.result);
	if (result && Object.hasOwn(result, "content")) {
		result = { ...result };
		delete result.content;
		data = { ...data, result };
		const candidate = withEntryData(entry, data);
		if (entryBytes(candidate) <= MAX_RETAINED_BYTES) return candidate;
	}
	result = record(data.result);
	if (result && Object.hasOwn(result, "output")) {
		result = { ...result, output: `[${ENTRY_FIELD_OMITTED}]` };
		data = { ...data, result };
		const candidate = withEntryData(entry, data);
		if (entryBytes(candidate) <= MAX_RETAINED_BYTES) return candidate;
	}

	const minimal: Record<string, unknown> = { omitted: ENTRY_DATA_OMITTED };
	for (const key of ["toolCallId", "tool", "title", "ok", "images"] as const) {
		if (Object.hasOwn(data, key)) minimal[key] = data[key];
	}
	result = record(data.result);
	if (result) minimal.result = { output: "", isError: result.isError === true };
	const candidate = withEntryData(entry, minimal);
	return entryBytes(candidate) <= MAX_RETAINED_BYTES
		? candidate
		: withEntryData(entry, { omitted: ENTRY_DATA_OMITTED });
}

/**
 * Incremental, bounded child-transcript bridge.
 *
 * One SessionEntryProjector is retained per child so tool calls/results and
 * parent aliases may span RPC chunks. Session-file paths remain inside the RPC
 * child; app-wire sees only sanitized DurableEntry values.
 */
export class AgentTranscriptProjection {
	#states = new Map<string, AgentTranscriptState>();
	#disposed = false;

	constructor(private readonly options: AgentTranscriptProjectionOptions) {}

	refresh(agentId: string): void {
		if (this.#disposed) return;
		const state = this.#state(agentId);
		state.queued = true;
		if (state.inFlight) return;
		state.inFlight = true;
		void this.#drain(state).finally(() => {
			state.inFlight = false;
			if (state.queued && !this.#disposed) queueMicrotask(() => this.refresh(agentId));
		});
	}
	artifact(artifactId: string): ArtifactDescriptor | undefined {
		for (const state of this.#states.values())
			for (const entry of state.retained) {
				if (entry.data.artifacts === undefined) continue;
				try {
					const artifact = decodeArtifactDescriptorList(entry.data.artifacts, "entry.data.artifacts").find(
						candidate => candidate.artifactId === artifactId,
					);
					if (artifact) return artifact;
				} catch {}
			}
		return undefined;
	}

	frames(): AgentTranscriptFrame[] {
		const revision = this.options.revision();
		const frames: AgentTranscriptFrame[] = [];
		for (const state of this.#states.values()) {
			if (state.seq === 0) continue;
			frames.push(this.#frame(state, state.retained, revision));
		}
		return frames;
	}

	transcriptImage(entryId: EntryId, sha256: string): TranscriptImageMetadata | undefined {
		for (const state of this.#states.values()) {
			const image = state.imageAuthorizations.get(entryId)?.find(candidate => candidate.sha256 === sha256);
			if (image) return image;
		}
		return undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#states.clear();
	}

	async #drain(state: AgentTranscriptState): Promise<void> {
		let reads = 0;
		while (!this.#disposed && state.queued && reads < MAX_DRAIN_READS) {
			state.queued = false;
			reads++;
			let result: RpcSubagentMessagesResult;
			try {
				result = await this.options.read(state.agentId, state.fromByte);
			} catch {
				return;
			}
			if (this.#disposed || this.#states.get(state.agentId) !== state) return;
			const advanced = this.#apply(state, result);
			if (advanced) state.queued = true;
		}
	}

	#apply(state: AgentTranscriptState, result: RpcSubagentMessagesResult): boolean {
		const reset = result.reset;
		if (reset) this.#reset(state);
		if (
			!Number.isSafeInteger(result.fromByte) ||
			!Number.isSafeInteger(result.nextByte) ||
			result.fromByte < 0 ||
			result.nextByte < result.fromByte ||
			result.fromByte !== state.fromByte
		) {
			this.#reset(state);
			state.queued = true;
			return false;
		}

		const fresh: DurableEntry[] = [];
		for (const value of result.entries) {
			const raw = record(value);
			if (!raw) continue;
			try {
				for (const entry of state.projector.project(raw)) fresh.push(boundedEntry(entry));
			} catch {
				// One malformed child row must not poison the parent session runtime.
			}
		}
		const advanced = result.nextByte > state.fromByte;
		state.fromByte = result.nextByte;
		if (fresh.length > 0) {
			this.#retain(state, fresh);
			for (const chunk of this.#chunks(fresh)) {
				state.seq++;
				this.options.emit(this.#frame(state, chunk, this.options.revision()));
			}
		} else if (reset) {
			state.seq++;
			this.options.emit(this.#frame(state, [], this.options.revision()));
		}
		return advanced;
	}

	#state(agentId: string): AgentTranscriptState {
		const existing = this.#states.get(agentId);
		if (existing) {
			this.#states.delete(agentId);
			this.#states.set(agentId, existing);
			return existing;
		}
		while (this.#states.size >= MAX_RETAINED_AGENTS) {
			const oldest = this.#states.entries().next();
			if (oldest.done) break;
			oldest.value[1].queued = false;
			this.#states.delete(oldest.value[0]);
		}
		const state: AgentTranscriptState = {
			agentId,
			projector: new SessionEntryProjector(
				this.options.hostId,
				this.options.sessionId,
				"live",
				[],
				this.options.artifactResolver,
			),
			fromByte: 0,
			generation: 0,
			seq: 0,
			retained: [],
			retainedBytes: 0,
			imageAuthorizations: new Map(),
			queued: false,
			inFlight: false,
		};
		this.#states.set(agentId, state);
		return state;
	}

	#reset(state: AgentTranscriptState): void {
		state.projector = new SessionEntryProjector(
			this.options.hostId,
			this.options.sessionId,
			"live",
			[],
			this.options.artifactResolver,
		);
		state.fromByte = 0;
		state.generation++;
		state.seq = 0;
		state.retained = [];
		state.retainedBytes = 0;
		state.imageAuthorizations.clear();
	}

	#retain(state: AgentTranscriptState, entries: readonly DurableEntry[]): void {
		for (const entry of entries) {
			state.imageAuthorizations.delete(entry.id);
			if (entry.data.images !== undefined) {
				try {
					const images = decodeTranscriptImageMetadataList(entry.data.images, "entry.data.images");
					if (images.length > 0) state.imageAuthorizations.set(entry.id, images);
				} catch {
					// Invalid metadata cannot authorize access to a content-addressed blob.
				}
			}
			while (state.imageAuthorizations.size > MAX_RETAINED_IMAGE_ENTRIES) {
				const oldest = state.imageAuthorizations.keys().next();
				if (oldest.done) break;
				state.imageAuthorizations.delete(oldest.value);
			}
			const bytes = entryBytes(entry);
			if (bytes > MAX_RETAINED_BYTES) continue;
			state.retained.push(entry);
			state.retainedBytes += bytes;
			while (state.retained.length > MAX_RETAINED_ENTRIES || state.retainedBytes > MAX_RETAINED_BYTES) {
				const removed = state.retained.shift();
				if (!removed) break;
				state.retainedBytes -= entryBytes(removed);
			}
		}
	}

	#chunks(entries: readonly DurableEntry[]): DurableEntry[][] {
		const chunks: DurableEntry[][] = [];
		let chunk: DurableEntry[] = [];
		let bytes = 0;
		for (const entry of entries) {
			const size = entryBytes(entry);
			if (size > MAX_RETAINED_BYTES) continue;
			if (chunk.length >= MAX_RETAINED_ENTRIES || (chunk.length > 0 && bytes + size > MAX_RETAINED_BYTES)) {
				chunks.push(chunk);
				chunk = [];
				bytes = 0;
			}
			chunk.push(entry);
			bytes += size;
		}
		if (chunk.length > 0) chunks.push(chunk);
		return chunks;
	}

	#frame(state: AgentTranscriptState, entries: readonly DurableEntry[], revision: Revision): AgentTranscriptFrame {
		return {
			v: "omp-app/1",
			type: "agent.transcript",
			hostId: this.options.hostId,
			sessionId: this.options.sessionId,
			agentId: wireAgentId(state.agentId),
			cursor: {
				epoch: transcriptEpoch(this.options.epoch, state.agentId, state.generation),
				seq: state.seq,
			},
			entries: [...entries],
			revision,
		};
	}
}
