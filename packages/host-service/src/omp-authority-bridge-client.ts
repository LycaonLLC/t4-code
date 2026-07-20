import type { DeviceCapability, ProjectId, SessionId, UsageReadResult } from "@t4-code/host-wire";
import { isAbsolute } from "node:path";
import {
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type OmpAuthorityBridgeMethod,
	type OmpAuthorityBridgeReady,
} from "./omp-authority-bridge-contract.ts";
import type { DesktopOperationsAuthority, OperationContext } from "./operations/dispatcher.ts";
import type {
	AppserverUsageAuthority,
	LockCheckHook,
	SessionAuthority,
	SessionDiscovery,
	SessionLockInspector,
	SessionRecord,
} from "./types.ts";

const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;

export interface OmpAuthorityBridgeChild {
	readonly stdin: { write(data: string): Promise<void> | void; end(): Promise<void> | void };
	readonly stdout: AsyncIterable<string | Uint8Array>;
	readonly stderr?: AsyncIterable<string | Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: string): void;
}

export interface OmpAuthorityBridgeInvocation {
	readonly executable: string;
	readonly argv?: readonly string[];
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface OmpAuthorityBridgeAuthorities {
	readonly hostInfo: () => Promise<{ readonly transcriptImageRoot: string }>;
	readonly sessionAuthority: SessionAuthority;
	readonly discovery: SessionDiscovery;
	readonly operationsAuthority: DesktopOperationsAuthority;
	readonly usageAuthority?: AppserverUsageAuthority;
	readonly projectRootForProject: (projectId: ProjectId) => Promise<string>;
	readonly projectRootForSession: (sessionId: SessionId) => Promise<string>;
	readonly lockCheck: LockCheckHook;
	readonly lockStatus: SessionLockInspector;
}

interface PendingRequest {
	readonly method: OmpAuthorityBridgeMethod;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly emitTerminalOutput?: (frame: unknown) => void;
}

function bridgeError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
	return value;
}

function contextPayload(context: OperationContext): Record<string, unknown> {
	return {
		hostId: context.hostId,
		...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
		deviceId: context.deviceId,
		connectionId: context.connectionId,
		capabilities: [...context.capabilities],
		...(context.currentRevision === undefined ? {} : { currentRevision: context.currentRevision }),
		...(context.expectedRevision === undefined ? {} : { expectedRevision: context.expectedRevision }),
	};
}

async function* lines(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	for await (const chunk of stream) {
		pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let index = pending.indexOf("\n");
		while (index >= 0) {
			yield pending.slice(0, index).replace(/\r$/u, "");
			pending = pending.slice(index + 1);
			index = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending) yield pending;
}

function defaultSpawn(invocation: OmpAuthorityBridgeInvocation): OmpAuthorityBridgeChild {
	const child = Bun.spawn([invocation.executable, ...(invocation.argv ?? ["bridge", "--stdio"])], {
		cwd: invocation.cwd,
		env: { ...process.env, ...invocation.environment },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdin: {
			write: data => Promise.resolve(child.stdin.write(data)).then(() => undefined),
			end: () => Promise.resolve(child.stdin.end()).then(() => undefined),
		},
		stdout: child.stdout as unknown as AsyncIterable<Uint8Array>,
		stderr: child.stderr as unknown as AsyncIterable<Uint8Array>,
		exited: child.exited,
		kill: signal => child.kill(signal as never),
	};
}

export class OmpAuthorityBridgeClient {
	readonly #methods = new Set<OmpAuthorityBridgeMethod>();
	readonly #pending = new Map<string, PendingRequest>();
	readonly #terminalOutputs = new Map<string, (frame: unknown) => void>();
	#child: OmpAuthorityBridgeChild | undefined;
	#ready: OmpAuthorityBridgeReady | undefined;
	#readyGate = Promise.withResolvers<OmpAuthorityBridgeReady>();
	#counter = 0;
	#closed = false;
	#stderr = "";

	constructor(
		private readonly invocation: OmpAuthorityBridgeInvocation,
		private readonly spawn: (invocation: OmpAuthorityBridgeInvocation) => OmpAuthorityBridgeChild = defaultSpawn,
	) {}

	get identity(): Pick<OmpAuthorityBridgeReady, "ompVersion" | "ompBuild"> {
		if (!this.#ready) throw new Error("OMP authority bridge is not ready");
		return { ompVersion: this.#ready.ompVersion, ompBuild: this.#ready.ompBuild };
	}

	async start(): Promise<OmpAuthorityBridgeReady> {
		if (this.#child) throw new Error("OMP authority bridge already started");
		if (this.#closed) throw new Error("OMP authority bridge is closed");
		const child = this.spawn(this.invocation);
		this.#child = child;
		void this.#readStdout(child);
		void this.#readStderr(child);
		void child.exited.then(code => this.#fail(new Error(`OMP authority bridge exited (${code}): ${this.#stderr}`)));
		const timeout = setTimeout(() => this.#fail(new Error("OMP authority bridge ready timeout")), READY_TIMEOUT_MS);
		try {
			return await this.#readyGate.promise;
		} finally {
			clearTimeout(timeout);
		}
	}

	async stop(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		this.#child = undefined;
		if (!child) return;
		await Promise.resolve(child.stdin.end()).catch(() => undefined);
		const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS));
		if ((await Promise.race([child.exited.then(() => "exited" as const), timeout])) === "timeout") child.kill("SIGTERM");
		this.#rejectPending(new Error("OMP authority bridge stopped"));
	}

	createAuthorities(): OmpAuthorityBridgeAuthorities {
		if (!this.#ready) throw new Error("OMP authority bridge is not ready");
		const call = (method: OmpAuthorityBridgeMethod, params: Record<string, unknown>, signal?: AbortSignal,
			emitTerminalOutput?: (frame: unknown) => void) => this.#request(method, params, signal, emitTerminalOutput);
		const sessionAuthority: SessionAuthority = {
			create: async (cwd, title) => call("session.create", { cwd, ...(title === undefined ? {} : { title }) }) as never,
			list: async () => call("session.list", {}) as never,
			archive: async (session, archivedAt) => { await call("session.archive", { session, archivedAt }); },
			restore: async session => { await call("session.restore", { session }); },
			delete: async session => { await call("session.delete", { session }); },
		};
		const discovery: SessionDiscovery = {
			list: () => sessionAuthority.list(),
			...(this.#methods.has("discovery.load")
				? { load: async (session: SessionRecord) => call("discovery.load", { session }) as Promise<SessionRecord> }
				: {}),
			...(this.#methods.has("discovery.page")
				? { page: async (session: SessionRecord, args: Record<string, unknown>) =>
					call("discovery.page", { session, args }) as never }
				: {}),
		};
		const operationsAuthority: DesktopOperationsAuthority = {};
		for (const method of this.#methods) {
			if (!method.startsWith("operation.")) continue;
			const name = method.slice("operation.".length) as keyof DesktopOperationsAuthority;
			(operationsAuthority as Record<string, unknown>)[name] = async (args: Record<string, unknown>, context: OperationContext) =>
				call(method, { args, context: contextPayload(context) }, context.abortSignal, context.emitTerminalOutput);
		}
		if (this.#methods.has("terminal.input")) operationsAuthority.terminalInput = async (frame, context) => {
			await call("terminal.input", { frame, context: contextPayload(context) }, context.abortSignal);
		};
		if (this.#methods.has("terminal.resize")) operationsAuthority.terminalResize = async (frame, context) => {
			await call("terminal.resize", { frame, context: contextPayload(context) }, context.abortSignal);
		};
		if (this.#methods.has("terminal.close")) operationsAuthority.terminalClose = async (frame, context) => {
			await call("terminal.close", { frame, context: contextPayload(context) }, context.abortSignal);
			this.#terminalOutputs.delete(String(frame.terminalId));
		};
		return {
			hostInfo: async () => {
				const value = asRecord(await call("host.info", {}), "host info");
				if (Object.keys(value).length !== 1 || !isAbsolute(asString(value.transcriptImageRoot, "transcript image root")))
					throw new Error("host info is invalid");
				return { transcriptImageRoot: value.transcriptImageRoot as string };
			},
			sessionAuthority,
			discovery,
			operationsAuthority,
			...(this.#methods.has("usage.read")
				? { usageAuthority: { read: signal => call("usage.read", {}, signal) as Promise<UsageReadResult> } }
				: {}),
			projectRootForProject: async projectId => asString(
				await call("project.rootForProject", { projectId }), "project root"),
			projectRootForSession: async sessionId => asString(
				await call("project.rootForSession", { sessionId }), "session root"),
			lockCheck: async session => { await call("lock.check", { session }); },
			lockStatus: async session => asString(await call("lock.status", { session }), "lock status") as never,
		};
	}

	async #request(
		method: OmpAuthorityBridgeMethod,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		emitTerminalOutput?: (frame: unknown) => void,
	): Promise<unknown> {
		if (!this.#child || !this.#ready || this.#closed) throw new Error("OMP authority bridge is unavailable");
		if (!this.#methods.has(method)) throw bridgeError("UNSUPPORTED", "OMP authority bridge method is unavailable");
		if (signal?.aborted) throw bridgeError("ABORTED", "operation was cancelled");
		const id = `request-${++this.#counter}`;
		const gate = Promise.withResolvers<unknown>();
		this.#pending.set(id, { method, resolve: gate.resolve, reject: gate.reject, emitTerminalOutput });
		const onAbort = (): void => {
			void this.#write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "cancel", id }).catch(() => undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await this.#write({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "request", id, method, params });
			return await gate.promise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		}
	}

	async #write(frame: Parameters<typeof encodeOmpAuthorityBridgeFrame>[0]): Promise<void> {
		const child = this.#child;
		if (!child) throw new Error("OMP authority bridge is unavailable");
		await child.stdin.write(encodeOmpAuthorityBridgeFrame(frame));
	}

	async #readStdout(child: OmpAuthorityBridgeChild): Promise<void> {
		try {
			for await (const line of lines(child.stdout)) {
				if (!line) continue;
				const frame = decodeOmpAuthorityBridgeServerFrame(JSON.parse(line));
				if (frame.type === "ready") {
					if (this.#ready) throw new Error("OMP authority bridge sent duplicate ready frame");
					this.#ready = frame;
					for (const method of frame.methods) this.#methods.add(method);
					this.#readyGate.resolve(frame);
					continue;
				}
				if (!this.#ready) throw new Error("OMP authority bridge sent data before ready");
				const pending = this.#pending.get(frame.id);
				if (frame.type === "event") {
					const payload = asRecord(frame.payload, "terminal event");
					const terminalId = typeof payload.terminalId === "string" ? payload.terminalId : undefined;
					const emit = pending?.emitTerminalOutput ?? (terminalId ? this.#terminalOutputs.get(terminalId) : undefined);
					emit?.(frame.payload);
					if (payload.type === "terminal.exit" && terminalId) this.#terminalOutputs.delete(terminalId);
					continue;
				}
				if (!pending) continue;
				if (frame.ok) {
					if (pending.method === "operation.termOpen" && pending.emitTerminalOutput) {
						const terminalId = asRecord(frame.result, "terminal result").terminalId;
						if (typeof terminalId === "string") this.#terminalOutputs.set(terminalId, pending.emitTerminalOutput);
					}
					pending.resolve(frame.result);
				} else pending.reject(bridgeError(frame.error.code, frame.error.message));
			}
			this.#fail(new Error("OMP authority bridge closed stdout"));
		} catch (error) {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async #readStderr(child: OmpAuthorityBridgeChild): Promise<void> {
		if (!child.stderr) return;
		const decoder = new TextDecoder("utf-8", { fatal: false });
		for await (const chunk of child.stderr) {
			this.#stderr = `${this.#stderr}${typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })}`.slice(-4096);
		}
	}

	#fail(error: Error): void {
		if (!this.#ready) this.#readyGate.reject(error);
		this.#rejectPending(error);
		if (!this.#closed) {
			this.#closed = true;
			this.#child?.kill("SIGTERM");
		}
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#terminalOutputs.clear();
	}
}
