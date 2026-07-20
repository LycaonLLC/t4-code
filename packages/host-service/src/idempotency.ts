import { createHash } from "node:crypto";
import type { CommandId, ServerFrame } from "@t4-code/host-wire";
import type { CommandOutcome } from "./types.ts";

function semantic(value: unknown, omitEnvelopeIdentifiers = false): unknown {
	if (Array.isArray(value)) return value.map(item => semantic(item));
	if (!value || typeof value !== "object") return value;
	const object = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(object)
			.filter(key => !omitEnvelopeIdentifiers || (key !== "requestId" && key !== "confirmationId"))
			.sort()
			.map(key => [key, semantic(object[key])]),
	);
}
function payloadHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(semantic(value, true)))
		.digest("hex");
}
export type IdempotencyResult =
	| { kind: "new" }
	| { kind: "pending"; outcome: Promise<CommandOutcome> }
	| { kind: "replay"; outcome: CommandOutcome }
	| { kind: "conflict"; hash: string };

const DEFAULT_COMPLETED_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_COMPLETED_ENTRIES = 1024;

interface IdempotencyEntry {
	hash: string;
	outcome?: CommandOutcome;
	pending?: Promise<CommandOutcome>;
	resolve?: (outcome: CommandOutcome) => void;
	completedAt?: number;
}

export interface IdempotencyStoreOptions {
	/** Clock injection keeps expiry deterministic in tests. */
	now?: () => number;
	/** Completed outcomes expire this long after completion. */
	completedTtlMs?: number;
	/** Least-recently-used completed outcomes retained after expiry pruning. */
	maxCompletedEntries?: number;
}

export class IdempotencyStore {
	#entries = new Map<string, IdempotencyEntry>();
	#now: () => number;
	#completedTtlMs: number;
	#maxCompletedEntries: number;

	constructor(options: IdempotencyStoreOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
		this.#maxCompletedEntries = options.maxCompletedEntries ?? DEFAULT_MAX_COMPLETED_ENTRIES;
		if (!Number.isFinite(this.#completedTtlMs) || this.#completedTtlMs <= 0)
			throw new Error("completedTtlMs must be a positive finite number");
		if (!Number.isSafeInteger(this.#maxCompletedEntries) || this.#maxCompletedEntries <= 0)
			throw new Error("maxCompletedEntries must be a positive safe integer");
	}

	begin(commandId: CommandId, payload: unknown): IdempotencyResult {
		const now = this.#readNow();
		this.#prune(now);
		const hash = payloadHash(payload);
		const existing = this.#entries.get(commandId);
		if (!existing) {
			const gate = Promise.withResolvers<CommandOutcome>();
			this.#entries.set(commandId, { hash, pending: gate.promise, resolve: gate.resolve });
			return { kind: "new" };
		}
		if (existing.hash !== hash) return { kind: "conflict", hash };
		if (existing.outcome) {
			this.#touch(commandId, existing);
			return { kind: "replay", outcome: existing.outcome };
		}
		if (!existing.pending) throw new Error("idempotency entry has neither a pending nor completed outcome");
		return { kind: "pending", outcome: existing.pending };
	}

	complete(commandId: CommandId, payload: unknown, outcome: CommandOutcome): void {
		const now = this.#readNow();
		this.#prune(now);
		const hash = payloadHash(payload);
		const current = this.#entries.get(commandId);
		if (!current) {
			this.#entries.set(commandId, { hash, outcome, completedAt: now });
			this.#prune(now);
			return;
		}
		if (current.hash !== hash) throw new Error("cannot complete a command with a conflicting payload");
		this.#settle(commandId, current, outcome, now);
	}

	unknown(commandId: CommandId): void {
		const current = this.#entries.get(commandId);
		if (!current) return;
		const now = this.#readNow();
		this.#settle(
			commandId,
			current,
			{
				unknown: true,
				frame: {
					v: "omp-app/1",
					type: "error",
					code: "outcome_unknown",
					message: "child ended before command outcome",
					requestId: commandId,
				} as ServerFrame,
			},
			now,
		);
	}

	#readNow(): number {
		const now = this.#now();
		if (!Number.isFinite(now)) throw new Error("idempotency clock must return a finite number");
		return now;
	}

	#settle(commandId: string, current: IdempotencyEntry, outcome: CommandOutcome, now: number): void {
		if (current.completedAt !== undefined) return;
		const resolve = current.resolve;
		current.outcome = outcome;
		current.completedAt = now;
		current.pending = undefined;
		current.resolve = undefined;
		this.#touch(commandId, current);
		resolve?.(outcome);
		this.#prune(now);
	}

	#touch(commandId: string, entry: IdempotencyEntry): void {
		this.#entries.delete(commandId);
		this.#entries.set(commandId, entry);
	}

	#prune(now: number): void {
		let completed = 0;
		for (const [commandId, entry] of this.#entries) {
			if (entry.completedAt === undefined) continue;
			if (now >= entry.completedAt && now - entry.completedAt >= this.#completedTtlMs) {
				this.#entries.delete(commandId);
				continue;
			}
			completed += 1;
		}
		if (completed <= this.#maxCompletedEntries) return;
		for (const [commandId, entry] of this.#entries) {
			if (entry.completedAt === undefined) continue;
			this.#entries.delete(commandId);
			completed -= 1;
			if (completed <= this.#maxCompletedEntries) return;
		}
	}
}
export { payloadHash };
