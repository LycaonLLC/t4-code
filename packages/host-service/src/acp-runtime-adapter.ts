import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

import { type ClientConnection, client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
	immutableRuntimeAdapterManifest,
	type RuntimeAdapter,
	type RuntimeAdapterCallbacks,
	type RuntimeAdapterFactory,
	type RuntimeAdapterManifest,
	type RuntimeCommand,
	type RuntimeSession,
	type RuntimeSessionRequest,
	RuntimeUnavailableError,
} from "./runtime-adapter.ts";

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_STDERR_BYTES = 65_536;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;

export interface AcpProcess {
	readonly stdin: WritableStream<Uint8Array>;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	terminate(signal?: "SIGTERM" | "SIGKILL"): void;
}

/** Injectable boundary for process creation and executable discovery. */
export interface AcpProcessRunner {
	executableAvailable(executable: string): Promise<boolean> | boolean;
	spawn(command: RuntimeCommand, cwd: string): AcpProcess | Promise<AcpProcess>;
}

export interface AcpRuntimeAdapterOptions {
	readonly runner?: AcpProcessRunner;
	readonly maxFrameBytes?: number;
	readonly maxStderrBytes?: number;
	readonly terminationGraceMs?: number;
	readonly initializationTimeoutMs?: number;
}

export class AcpTransportError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "AcpTransportError";
	}
}

/** The provider may have acted before its ACP transport disappeared. */
export class AcpUnknownOutcomeError extends AcpTransportError {
	readonly sessionId: string;

	constructor(sessionId: string, cause?: unknown) {
		super(`ACP transport was lost; prompt outcome is unknown for session ${sessionId}`, cause);
		this.name = "AcpUnknownOutcomeError";
		this.sessionId = sessionId;
	}
}

async function exitsWithin(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			exited.then(
				() => true,
				() => true,
			),
			new Promise<boolean>(resolve => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

async function terminateProcess(process: AcpProcess, graceMs: number): Promise<void> {
	process.terminate();
	if (await exitsWithin(process.exited, graceMs)) return;
	process.terminate("SIGKILL");
	if (!(await exitsWithin(process.exited, graceMs)))
		throw new AcpTransportError("ACP runtime did not exit after SIGKILL");
}

class AcpInitializationTimeoutError extends AcpTransportError {}

async function initializationStep<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	const expiration = Promise.withResolvers<T>();
	const timeout = setTimeout(
		() => expiration.reject(new AcpInitializationTimeoutError("ACP initialization timed out")),
		timeoutMs,
	);
	try {
		return await Promise.race([operation, expiration.promise]);
	} finally {
		clearTimeout(timeout);
	}
}

export const bunAcpProcessRunner: AcpProcessRunner = {
	executableAvailable(executable) {
		return Bun.which(executable) !== null;
	},
	spawn(command, cwd) {
		const child = spawn(
			command.executable,
			[...command.arguments, ...(command.cwdArgument ? [command.cwdArgument, cwd] : [])],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		if (!child.stdin || !child.stdout || !child.stderr) {
			throw new AcpTransportError("ACP runtime did not expose stdio pipes");
		}
		const exited = new Promise<number>(resolve => {
			child.once("exit", code => resolve(code ?? 1));
			child.once("error", () => resolve(1));
		});
		return {
			stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
			stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
			exited,
			terminate(signal = "SIGTERM") {
				child.kill(signal);
			},
		};
	},
};

function boundNdjsonFrames(source: ReadableStream<Uint8Array>, maxFrameBytes: number): ReadableStream<Uint8Array> {
	let frameBytes = 0;
	return source.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				for (const byte of chunk) {
					if (byte === 10) {
						frameBytes = 0;
						continue;
					}
					frameBytes += 1;
					if (frameBytes > maxFrameBytes) {
						throw new AcpTransportError(`ACP frame exceeds ${maxFrameBytes} bytes`);
					}
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

async function consumeStderr(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	callbacks: RuntimeAdapterCallbacks | undefined,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let remaining = maxBytes;
	let output = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return output + decoder.decode();
			const bounded = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			remaining -= bounded.byteLength;
			const text = decoder.decode(bounded, { stream: true });
			output += text;
			if (text.length > 0) await callbacks?.onStderr?.(text);
		}
	} finally {
		reader.releaseLock();
	}
}

export class AcpRuntimeAdapter implements RuntimeAdapter {
	readonly manifest: RuntimeAdapterManifest;
	readonly #runner: AcpProcessRunner;
	readonly #maxFrameBytes: number;
	readonly #maxStderrBytes: number;
	readonly #terminationGraceMs: number;
	readonly #initializationTimeoutMs: number;

	constructor(manifest: RuntimeAdapterManifest, options: AcpRuntimeAdapterOptions = {}) {
		this.manifest = immutableRuntimeAdapterManifest(manifest);
		this.#runner = options.runner ?? bunAcpProcessRunner;
		this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		this.#maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.#terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
		this.#initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1) {
			throw new RangeError("maxFrameBytes must be a positive safe integer");
		}
		if (!Number.isSafeInteger(this.#maxStderrBytes) || this.#maxStderrBytes < 1) {
			throw new RangeError("maxStderrBytes must be a positive safe integer");
		}
		if (!Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs < 1) {
			throw new RangeError("terminationGraceMs must be a positive safe integer");
		}
		if (!Number.isSafeInteger(this.#initializationTimeoutMs) || this.#initializationTimeoutMs < 1) {
			throw new RangeError("initializationTimeoutMs must be a positive safe integer");
		}
	}

	async openSession(request: RuntimeSessionRequest): Promise<RuntimeSession> {
		const { workspace } = request;
		if (!workspace.instanceId || !isAbsolute(workspace.cwd)) {
			throw new AcpTransportError("ACP sessions require an identified absolute workspace cwd");
		}
		if (!(await this.#runner.executableAvailable(this.manifest.command.executable))) {
			throw new RuntimeUnavailableError(this.manifest.command.executable);
		}

		let process: AcpProcess;
		try {
			process = await this.#runner.spawn(this.manifest.command, workspace.cwd);
		} catch (cause) {
			throw new AcpTransportError(`Unable to start ACP runtime ${this.manifest.id}`, cause);
		}

		const stderr = consumeStderr(process.stderr, this.#maxStderrBytes, request.callbacks);
		let closed = false;
		let disposed = false;
		let sessionId: string | undefined;
		let sessionStartIssued = false;
		let connection: ClientConnection | undefined;
		const markClosed = () => {
			closed = true;
		};
		try {
			const app = client({ name: "oh-my-pi-appserver" })
				.onNotification(methods.client.session.update, async ({ params }) => {
					if (params.sessionId !== sessionId) {
						throw new AcpTransportError("ACP update addressed a session not owned by this process");
					}
					await request.callbacks?.onSessionUpdate?.(params);
				})
				.onRequest(methods.client.session.requestPermission, async ({ params }) => {
					if (params.sessionId !== sessionId) {
						throw new AcpTransportError("ACP permission request addressed a session not owned by this process");
					}
					const response = await request.callbacks?.onPermissionRequest?.(params);
					if (
						response?.outcome === "selected" &&
						typeof response.optionId === "string" &&
						params.options.some(option => option.optionId === response.optionId)
					)
						return { outcome: { outcome: "selected", optionId: response.optionId } };
					return { outcome: { outcome: "cancelled" } };
				});
			connection = app.connect(ndJsonStream(process.stdin, boundNdjsonFrames(process.stdout, this.#maxFrameBytes)));
			connection.closed.then(markClosed, markClosed);
			process.exited.then(markClosed, markClosed);

			await initializationStep(
				connection.agent.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientInfo: { name: "oh-my-pi-appserver", version: "0.1.0" },
				}),
				this.#initializationTimeoutMs,
			);
			if (request.sessionId) {
				sessionId = request.sessionId;
				sessionStartIssued = true;
				await initializationStep(
					connection.agent.request(methods.agent.session.load, {
						cwd: workspace.cwd,
						mcpServers: [],
						sessionId: request.sessionId,
					}),
					this.#initializationTimeoutMs,
				);
			} else {
				sessionStartIssued = true;
				sessionId = (
					await initializationStep(
						connection.agent.request(methods.agent.session.new, {
							cwd: workspace.cwd,
							mcpServers: [],
						}),
						this.#initializationTimeoutMs,
					)
				).sessionId;
			}
			if (!sessionId) throw new AcpTransportError("ACP runtime returned an empty session ID");
		} catch (cause) {
			const transportWasClosed = closed;
			connection?.close(cause);
			try {
				await terminateProcess(process, this.#terminationGraceMs);
			} catch (terminationCause) {
				throw new AcpTransportError("ACP initialization failed and child termination could not be confirmed", {
					cause,
					terminationCause,
				});
			}
			await stderr.catch(() => "");
			if (sessionStartIssued && (transportWasClosed || cause instanceof AcpInitializationTimeoutError)) {
				throw new AcpUnknownOutcomeError(request.sessionId ?? "uninitialized", cause);
			}
			if (transportWasClosed) throw new AcpTransportError("ACP transport was lost during initialization", cause);
			throw cause;
		}
		if (!connection) throw new AcpTransportError("ACP connection was not established");
		if (!sessionId) throw new AcpTransportError("ACP runtime returned an empty session ID");
		const ownedConnection = connection;
		const ownedSessionId = sessionId;
		const terminationGraceMs = this.#terminationGraceMs;
		return {
			adapterId: this.manifest.id,
			sessionId: ownedSessionId,
			workspace,
			async prompt(text) {
				if (disposed) throw new AcpTransportError("ACP session has been disposed");
				if (closed) throw new AcpUnknownOutcomeError(ownedSessionId);
				try {
					return await ownedConnection.agent.request(methods.agent.session.prompt, {
						sessionId: ownedSessionId,
						prompt: [{ type: "text", text }],
					});
				} catch (cause) {
					if (closed) throw new AcpUnknownOutcomeError(ownedSessionId, cause);
					throw cause;
				}
			},
			async cancel() {
				if (disposed) throw new AcpTransportError("ACP session has been disposed");
				if (closed) throw new AcpUnknownOutcomeError(ownedSessionId);
				try {
					await ownedConnection.agent.notify(methods.agent.session.cancel, { sessionId: ownedSessionId });
				} catch (cause) {
					if (closed) throw new AcpUnknownOutcomeError(ownedSessionId, cause);
					throw cause;
				}
			},
			async dispose() {
				if (disposed) return;
				disposed = true;
				ownedConnection.close();
				await terminateProcess(process, terminationGraceMs);
			},
		};
	}
}

export function createAcpRuntimeAdapterFactory(options: AcpRuntimeAdapterOptions = {}): RuntimeAdapterFactory {
	return {
		create(manifest) {
			return new AcpRuntimeAdapter(manifest, options);
		},
	};
}
