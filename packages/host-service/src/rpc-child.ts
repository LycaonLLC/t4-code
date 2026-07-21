import { dirname, resolve } from "node:path";
import { boundedMap, parseBounded, type OperationCapability } from "@t4-code/host-wire";
import type { RpcResponse, RpcSessionEntryFrame } from "./omp-rpc-contract.ts";
import type { ManagedRpcImageRef } from "./image-upload-store.ts";
import { OfficialOmpCapabilityAdapter } from "./official-omp-capabilities.ts";
import type { ChildHandle, RpcChildFactory, SessionRecord } from "./types.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const STDERR_BYTES = 64 * 1024;
const FAILURE_STOP_GRACE_MS = 2_000;

export interface ChildCallbacks {
	entry(frame: RpcSessionEntryFrame): void;
	event(frame: Record<string, unknown>): void;
	capabilities?(operations: readonly OperationCapability[]): void;
	crashed(error: Error): void;
}

export interface RpcLoadedTranscriptWatermark {
	readonly lastEntryId: string | null;
	readonly entryCount: number;
}

export interface RpcChildInvocation {
	executable: string;
	prefixArgv: readonly string[];
}

export interface RpcChildInvocationOverrides {
	compiled?: boolean;
	executable?: string;
	main?: string;
}

export function resolveRpcChildInvocation(overrides: RpcChildInvocationOverrides = {}): RpcChildInvocation {
	const executable = overrides.executable ?? process.execPath;
	if (typeof executable !== "string" || executable.trim().length === 0)
		throw new Error("rpc child executable is empty");
	const compiled = overrides.compiled ?? process.env.PI_COMPILED === "true";
	const runningMain = overrides.main ?? Bun.main;
	const runningCodingAgentDaemon = typeof runningMain === "string" && runningMain.endsWith("/cli/ompd.ts");
	const main = runningCodingAgentDaemon ? resolve(dirname(runningMain), "../cli.ts") : runningMain;
	if (!compiled && (typeof main !== "string" || main.trim().length === 0))
		throw new Error("rpc child CLI entry is empty");
	return { executable, prefixArgv: Object.freeze(compiled ? [] : [main]) };
}

export class BunRpcChildFactory implements RpcChildFactory {
	#executable: string;
	#prefixArgv: readonly string[];
	#imageRoot: string | undefined;

	constructor(invocation: string | RpcChildInvocation = resolveRpcChildInvocation(), imageRoot?: string) {
		const resolved = typeof invocation === "string" ? { executable: invocation, prefixArgv: [] } : invocation;
		if (typeof resolved.executable !== "string" || resolved.executable.trim().length === 0) {
			throw new Error("rpc child executable is empty");
		}
		if (
			!Array.isArray(resolved.prefixArgv) ||
			resolved.prefixArgv.some(arg => typeof arg !== "string" || arg.length === 0)
		) {
			throw new Error("rpc child prefix argv is invalid");
		}
		this.#executable = resolved.executable;
		this.#prefixArgv = Object.freeze([...resolved.prefixArgv]);
		this.#imageRoot = imageRoot;
	}

	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle {
		const child = Bun.spawn(spec.argv, {
			cwd: spec.cwd,
			env: {
				...process.env,
				OMP_APP_RPC_INLINE_IMAGE_DATA: "omit",
				OMP_APP_RPC_SESSION_ENTRIES: "1",
				OMP_APP_SUBAGENT_SUBSCRIPTION: "progress",
				...(this.#imageRoot ? { OMP_APP_RPC_IMAGE_ROOT: this.#imageRoot } : {}),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			stdin: { write: data => Promise.resolve(child.stdin.write(data)).then(() => undefined) },
			stdout: child.stdout as unknown as AsyncIterable<Uint8Array>,
			stderr: child.stderr as unknown as AsyncIterable<Uint8Array>,
			exited: child.exited,
			kill: signal => child.kill(signal as never),
		};
	}

	argv(sessionPath: string): string[] {
		return [this.#executable, ...this.#prefixArgv, "--mode", "rpc", "--session", sessionPath];
	}
}

function stringBytes(value: string): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) throw new Error("invalid UTF-8 stdout");
			bytes += 4;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid UTF-8 stdout");
		else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}

async function* lines(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	for await (const chunk of stream) {
		let text: string;
		try {
			text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		} catch {
			throw new Error("invalid UTF-8 stdout");
		}
		pending += text;
		if (stringBytes(pending) > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB");
		let index = pending.indexOf("\n");
		while (index >= 0) {
			const line = pending.slice(0, index).replace(/\r$/, "");
			pending = pending.slice(index + 1);
			yield line;
			index = pending.indexOf("\n");
		}
	}
	try {
		pending += decoder.decode();
	} catch {
		throw new Error("invalid UTF-8 stdout");
	}
	if (pending) {
		if (stringBytes(pending) > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB");
		yield pending;
	}
}

export class RpcChildSupervisor {
	#child?: ChildHandle;
	#pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
	#ignoredResponses = new Set<string>();
	#closed = false;
	#readyReject?: (error: Error) => void;
	#loadedWatermark?: RpcLoadedTranscriptWatermark;
	#counter = 0;
	#stderr = "";
	#ready = false;
	#termination?: Promise<void>;
	#operationCapabilities = new OfficialOmpCapabilityAdapter();
	constructor(
		private readonly factory: RpcChildFactory,
		private readonly session: SessionRecord,
		private readonly callbacks: ChildCallbacks,
		private readonly argv = ["omp", "--mode", "rpc"],
		private readonly failureStopGraceMs = FAILURE_STOP_GRACE_MS,
	) {
		if (!Number.isSafeInteger(failureStopGraceMs) || failureStopGraceMs <= 0 || failureStopGraceMs > 60_000)
			throw new Error("failureStopGraceMs must be between 1 and 60000");
	}
	hasPendingCalls(): boolean {
		return this.#pending.size > 0;
	}
	async start(): Promise<void> {
		if (this.#child) throw new Error("child already started");
		this.#child = this.factory.spawn({ session: this.session, argv: this.argv, cwd: this.session.cwd });
		const ready = Promise.withResolvers<void>();
		this.#readyReject = ready.reject;
		void this.readStdout(ready);
		void this.readStderr();
		void this.#child.exited.then(code => {
			if (!this.#closed && code !== 0) this.fail(new Error(`rpc child exited (${code}): ${this.#stderr}`));
		});
		const timer = setTimeout(() => ready.reject(new Error("rpc child ready timeout")), 10_000);
		try {
			await ready.promise;
		} catch (error) {
			this.stop();
			throw error;
		} finally {
			clearTimeout(timer);
			this.#readyReject = undefined;
		}
	}
	async call(
		command: Record<string, unknown>,
		requestId: string,
		signal?: AbortSignal,
		onDispatched?: (internalId: string) => void,
		abortChild = true,
	): Promise<RpcResponse> {
		if (!this.#child || this.#closed || !this.#ready) throw new Error("rpc child unavailable");
		// A caller can disconnect while the supervisor is still starting. Do not
		// enqueue a cancel followed by the original command once that wait ends.
		if (signal?.aborted) throw new Error("rpc call aborted");
		const internalId = `${requestId}:${++this.#counter}`;
		const promise = Promise.withResolvers<RpcResponse>();
		this.#pending.set(internalId, promise);
		const onAbort = () => {
			const pending = this.#pending.get(internalId);
			if (!pending) return;
			this.#pending.delete(internalId);
			this.#ignoredResponses.add(internalId);
			pending.reject(new Error("rpc call aborted"));
			if (abortChild) void this.cancel(`${requestId}:cancel`).catch(() => undefined);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const line = `${JSON.stringify({ ...command, id: internalId })}\n`;
			if (stringBytes(line) > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB");
			onDispatched?.(internalId);
			// onDispatched is synchronous, so this also closes the only gap before
			// the write where user code could abort the signal.
			if (signal?.aborted) return await promise.promise;
			await this.#child.stdin.write(line);
			const response = await promise.promise;
			if (response.type !== "response" || response.command !== command.type || typeof response.success !== "boolean")
				throw new Error("rpc response command mismatch");
			return response;
		} catch (error) {
			this.#pending.delete(internalId);
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
	/** Refresh the normalized operation catalog from stock OMP's RPC capability endpoint. */
	async refreshOperationCapabilities(requestId: string, signal?: AbortSignal): Promise<readonly OperationCapability[]> {
		const result = await this.call({ type: "get_available_commands" }, requestId, signal, undefined, false);
		if (!result.success) throw new Error(result.error);
		const data = boundedMap(result.data, "get_available_commands.data", 4);
		const operations = this.#operationCapabilities.update(data.commands);
		this.callbacks.capabilities?.(operations);
		return operations;
	}
	async prompt(
		id: string,
		message: string,
		signal?: AbortSignal,
		onDispatched?: (internalId: string) => void,
		appImageRefs?: readonly ManagedRpcImageRef[],
	): Promise<RpcResponse> {
		this.#operationCapabilities.assertPromptSupported(message);
		return this.call(
			{ type: "prompt", message, ...(appImageRefs ? { appImageRefs } : {}) },
			id,
			signal,
			onDispatched,
		);
	}
	async cancel(id: string): Promise<RpcResponse> {
		// Appserver owns accepted queued messages separately from the running root.
		// Resume those messages after aborting the root instead of applying the
		// interactive UI's "stop until the next explicit prompt" latch.
		return this.call({ type: "abort", resumeQueuedMessages: true }, id);
	}
	async cancelSubagent(agentId: unknown, id: string): Promise<RpcResponse> {
		// This is accepted work after confirmation, so it deliberately has no
		// caller abort signal. A disconnect cannot revoke it after dispatch.
		return this.call({ type: "cancel_subagent", agentId }, id, undefined, undefined, false);
	}
	async respondUi(
		requestId: string,
		payload: { value?: string; confirmed?: boolean; cancelled?: true },
	): Promise<void> {
		if (!this.#child || this.#closed || !this.#ready) throw new Error("rpc child unavailable");
		const line = `${JSON.stringify({ type: "extension_ui_response", id: requestId, ...payload })}\n`;
		if (stringBytes(line) > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB");
		await this.#child.stdin.write(line);
	}
	stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
		const child = this.#child;
		this.#closed = true;
		try {
			child?.kill(signal);
		} catch {}
		this.fail(new Error("rpc child stopped"));
		// The owner must retain this handle until `exited` settles. Clearing it
		// here would let lifecycle retries lose track of a signal-resistant child.
	}
	loadedWatermark(): RpcLoadedTranscriptWatermark | undefined {
		return this.#loadedWatermark;
	}
	child(): ChildHandle | undefined {
		return this.#child;
	}
	operationCapabilities(): readonly OperationCapability[] {
		return this.#operationCapabilities.operations();
	}
	assertOperationSupported(operationId: string): OperationCapability {
		return this.#operationCapabilities.assertOperationSupported(operationId);
	}
	private async readStdout(ready: { resolve: () => void; reject: (error: Error) => void }): Promise<void> {
		try {
			for await (const line of lines(this.#child!.stdout)) {
				if (!line) continue;
				let value: unknown;
				try {
					value = parseBounded(line);
				} catch {
					throw new Error("malformed rpc stdout");
				}
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new Error("rpc frame must be an object");
				const frame = value as Record<string, unknown>;
				if (frame.type === "ready") {
					const watermark = frame.transcriptWatermark;
					if (watermark && typeof watermark === "object" && !Array.isArray(watermark)) {
						const candidate = watermark as Record<string, unknown>;
						const lastEntryId = candidate.lastEntryId;
						const entryCount = candidate.entryCount;
						if (
							((typeof lastEntryId === "string" && lastEntryId.length <= 256) || lastEntryId === null) &&
							typeof entryCount === "number" &&
							Number.isSafeInteger(entryCount) &&
							entryCount >= 0
						)
							this.#loadedWatermark = { lastEntryId, entryCount };
					}
					if (this.#ready) throw new Error("duplicate rpc ready");
					this.#ready = true;
					ready.resolve();
					continue;
				}
				this.dispatch(frame);
			}
			if (!this.#closed) this.fail(new Error("rpc child stdout EOF"), true);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			ready.reject(failure);
			this.fail(failure, true);
		}
	}
	private async readStderr(): Promise<void> {
		if (!this.#child?.stderr) return;
		try {
			for await (const chunk of this.#child.stderr) {
				const text =
					typeof chunk === "string"
						? chunk.slice(-STDERR_BYTES)
						: new TextDecoder("utf-8", { fatal: false }).decode(
								chunk.byteLength > STDERR_BYTES ? chunk.slice(-STDERR_BYTES) : chunk,
							);
				this.#stderr = `${this.#stderr}${text}`.slice(-STDERR_BYTES);
			}
		} catch {}
	}
	private dispatch(value: Record<string, unknown>): void {
		// stop() deliberately keeps draining the process handle until exit, but
		// buffered stdout from that stopped child no longer owns session state.
		if (this.#closed) return;
		if (this.#operationCapabilities.consume(value)) {
			this.callbacks.capabilities?.(this.#operationCapabilities.operations());
			return;
		}
		if (value.type === "response") {
			if (typeof value.id !== "string" || typeof value.command !== "string" || typeof value.success !== "boolean")
				throw new Error("malformed rpc response");
			const pending = this.#pending.get(value.id);
			if (!pending) {
				if (this.#ignoredResponses.delete(value.id)) return;
				throw new Error("rpc response has unknown id");
			}
			this.#pending.delete(value.id);
			if (!value.success && typeof value.error !== "string") pending.reject(new Error("rpc response missing error"));
			else pending.resolve(value as unknown as RpcResponse);
			return;
		}
		if (value.type === "session_entry") {
			if (!value.entry || typeof value.entry !== "object" || Array.isArray(value.entry))
				throw new Error("malformed rpc session entry");
			this.callbacks.entry(value as unknown as RpcSessionEntryFrame);
			return;
		}
		if (typeof value.type !== "string") throw new Error("rpc frame type is missing");
		this.callbacks.event(value);
	}
	private terminateAfterReaderFailure(): void {
		if (this.#termination || !this.#child) return;
		const child = this.#child;
		this.#termination = (async () => {
			try {
				child.kill("SIGTERM");
			} catch {}
			const exited = await Promise.race([
				child.exited.then(
					() => true,
					() => true,
				),
				Bun.sleep(this.failureStopGraceMs).then(() => false),
			]);
			if (exited) return;
			try {
				child.kill("SIGKILL");
			} catch {}
			await child.exited.catch(() => undefined);
		})();
	}
	private fail(error: Error, terminateChild = false): void {
		this.#readyReject?.(error);
		this.#readyReject = undefined;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		if (!this.#closed) {
			this.#closed = true;
			if (terminateChild) this.terminateAfterReaderFailure();
			this.callbacks.crashed(error);
		}
	}
}
