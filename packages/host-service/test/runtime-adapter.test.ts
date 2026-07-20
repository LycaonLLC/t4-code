import { describe, expect, test } from "bun:test";
import {
	type AcpProcess,
	type AcpProcessRunner,
	AcpRuntimeAdapter,
	AcpTransportError,
	AcpUnknownOutcomeError,
} from "../src/acp-runtime-adapter.ts";
import {
	type RuntimeAdapterManifest,
	RuntimeAdapterRegistry,
	RuntimeAdapterRegistryError,
	type RuntimePermissionResponse,
	RuntimeUnavailableError,
	type RuntimeWorkspaceIdentity,
} from "../src/runtime-adapter.ts";
import { ACP_RUNTIME_PRESETS } from "../src/runtime-adapter-presets.ts";

type JsonRpcMessage = {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
};

class FakeAcpPeer implements AcpProcess {
	readonly requests: JsonRpcMessage[] = [];
	readonly sessionCwds: string[] = [];
	readonly permissionResponses: JsonRpcMessage[] = [];
	readonly #exit = Promise.withResolvers<number>();
	readonly exited = this.#exit.promise;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly stdin: WritableStream<Uint8Array>;
	readonly #encoder = new TextEncoder();
	readonly #decoder = new TextDecoder();
	#controller?: ReadableStreamDefaultController<Uint8Array>;
	#stderrController?: ReadableStreamDefaultController<Uint8Array>;
	#buffer = "";
	#pendingPromptId?: string | number;
	#closed = false;
	terminated = 0;
	signals: Array<"SIGTERM" | "SIGKILL"> = [];
	cancelled = 0;

	constructor(
		private readonly options: {
			readonly malformedOnInitialize?: boolean;
			readonly malformedOnInitializeAndStayAlive?: boolean;
			readonly closeOnPrompt?: boolean;
			readonly rejectSessionNew?: boolean;
			readonly hangOnSessionNew?: boolean;
			readonly ignoreSigterm?: boolean;
		} = {},
	) {
		this.stdout = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
		});
		this.stderr = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#stderrController = controller;
			},
		});
		this.stdin = new WritableStream<Uint8Array>({
			write: async chunk => {
				this.#buffer += this.#decoder.decode(chunk, { stream: true });
				for (;;) {
					const newline = this.#buffer.indexOf("\n");
					if (newline < 0) return;
					const line = this.#buffer.slice(0, newline);
					this.#buffer = this.#buffer.slice(newline + 1);
					if (line.length > 0) await this.#handle(JSON.parse(line) as JsonRpcMessage);
				}
			},
		});
	}

	terminate(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
		this.terminated += 1;
		this.signals.push(signal);
		if (signal === "SIGTERM" && this.options.ignoreSigterm) return;
		this.close(0);
	}

	close(code = 1): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const controller of [this.#controller, this.#stderrController]) {
			try {
				controller?.close();
			} catch (cause) {
				if (!(cause instanceof TypeError)) throw cause;
			}
		}
		this.#exit.resolve(code);
	}

	#send(message: JsonRpcMessage): void {
		if (this.#closed) return;
		this.#controller?.enqueue(this.#encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
	}

	async #handle(message: JsonRpcMessage): Promise<void> {
		this.requests.push(message);
		if (message.method === "initialize") {
			if (this.options.malformedOnInitialize || this.options.malformedOnInitializeAndStayAlive) {
				this.#controller?.enqueue(this.#encoder.encode("{not-json}\n"));
				if (!this.options.malformedOnInitializeAndStayAlive) this.close();
				return;
			}
			this.#send({ id: message.id, result: { protocolVersion: 1 } });
			return;
		}
		if (message.method === "session/new") {
			this.sessionCwds.push(String(message.params?.cwd));
			if (this.options.rejectSessionNew) {
				this.#send({ id: message.id, error: { code: -32_000, message: "provider rejected session" } });
				return;
			}
			if (!this.options.hangOnSessionNew) this.#send({ id: message.id, result: { sessionId: "peer-session" } });
			return;
		}
		if (message.method === "session/load") {
			this.sessionCwds.push(String(message.params?.cwd));
			this.#send({ id: message.id, result: {} });
			return;
		}
		if (message.method === "session/prompt") {
			if (this.options.closeOnPrompt) {
				this.close();
				return;
			}
			this.#pendingPromptId = message.id;
			this.#send({
				method: "session/update",
				params: {
					sessionId: "peer-session",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "opaque update" },
					},
				},
			});
			this.#send({
				id: "permission-1",
				method: "session/request_permission",
				params: {
					sessionId: "peer-session",
					toolCall: { toolCallId: "tool-1" },
					options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
				},
			});
			return;
		}
		if (message.id === "permission-1") {
			this.permissionResponses.push(message);
			this.#send({ id: this.#pendingPromptId, result: { stopReason: "end_turn" } });
			return;
		}
		if (message.method === "session/cancel") this.cancelled += 1;
	}
}

class FakeRunner implements AcpProcessRunner {
	readonly spawns: Array<{ command: RuntimeAdapterManifest["command"]; cwd: string }> = [];
	constructor(
		readonly peer: FakeAcpPeer,
		private readonly available = true,
	) {}
	executableAvailable(): boolean {
		return this.available;
	}
	spawn(command: RuntimeAdapterManifest["command"], cwd: string): AcpProcess {
		this.spawns.push({ command, cwd });
		return this.peer;
	}
}

const manifest: RuntimeAdapterManifest = {
	id: "test-acp",
	displayName: "Test ACP",
	command: { executable: "fake-acp", arguments: [] },
	capabilities: { prompt: "native", cancel: "native" },
};
const workspace: RuntimeWorkspaceIdentity = {
	instanceId: "workspace-instance",
	cwd: "/tmp/acp-workspace",
	ownership: "managed",
};

describe("ACP runtime adapter", () => {
	test("isolates one ACP process, forwards opaque updates and permissions, and owns cancellation", async () => {
		const peer = new FakeAcpPeer();
		const runner = new FakeRunner(peer);
		const updates: unknown[] = [];
		const permissions: unknown[] = [];
		const adapter = new AcpRuntimeAdapter(manifest, { runner });
		const session = await adapter.openSession({
			workspace,
			callbacks: {
				onSessionUpdate: update => {
					updates.push(update);
				},
				onPermissionRequest: permission => {
					permissions.push(permission);
					return { outcome: "selected", optionId: "allow" };
				},
			},
		});

		expect(session.sessionId).toBe("peer-session");
		expect(runner.spawns).toEqual([{ command: manifest.command, cwd: workspace.cwd }]);
		expect(peer.sessionCwds).toEqual([workspace.cwd]);
		await expect(session.prompt("hello")).resolves.toEqual({ stopReason: "end_turn" });
		expect(updates).toEqual([
			{
				sessionId: "peer-session",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "opaque update" },
				},
			},
		]);
		expect(permissions).toHaveLength(1);
		expect(peer.permissionResponses[0]?.result).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});
		await session.cancel();
		expect(peer.cancelled).toBe(1);
		await session.dispose();
		expect(peer.terminated).toBe(1);
	});

	test("fails closed when a callback selects an unoffered permission option", async () => {
		const peer = new FakeAcpPeer();
		const session = await new AcpRuntimeAdapter(manifest, { runner: new FakeRunner(peer) }).openSession({
			workspace,
			callbacks: {
				onPermissionRequest: () => ({ outcome: "selected", optionId: "unoffered" }) as RuntimePermissionResponse,
			},
		});
		await expect(session.prompt("permission")).resolves.toEqual({ stopReason: "end_turn" });
		expect(peer.permissionResponses[0]?.result).toEqual({ outcome: { outcome: "cancelled" } });
		await session.dispose();
	});

	test("loads only the supplied session into its own workspace process", async () => {
		const peer = new FakeAcpPeer();
		const session = await new AcpRuntimeAdapter(manifest, { runner: new FakeRunner(peer) }).openSession({
			workspace,
			sessionId: "existing-session",
		});
		expect(session.sessionId).toBe("existing-session");
		expect(peer.sessionCwds).toEqual([workspace.cwd]);
		await session.dispose();
	});

	test("reports unavailable executables without selecting another runtime", async () => {
		const peer = new FakeAcpPeer();
		const runner = new FakeRunner(peer, false);
		const adapter = new AcpRuntimeAdapter(manifest, { runner });
		const registry = new RuntimeAdapterRegistry(runner);
		registry.register(adapter);
		expect(await registry.availability(manifest.id)).toEqual({ state: "unavailable", executable: "fake-acp" });
		await expect(registry.openSession(manifest.id, { workspace })).rejects.toBeInstanceOf(RuntimeUnavailableError);
		expect(runner.spawns).toHaveLength(0);
	});

	test("escalates only its owned child after bounded graceful termination", async () => {
		const peer = new FakeAcpPeer({ ignoreSigterm: true });
		const session = await new AcpRuntimeAdapter(manifest, {
			runner: new FakeRunner(peer),
			terminationGraceMs: 1,
		}).openSession({ workspace });
		await session.dispose();
		expect(peer.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(peer.terminated).toBe(2);
	});

	test("kills a child whose initialization fails while stderr and the process remain open", async () => {
		const peer = new FakeAcpPeer({ malformedOnInitializeAndStayAlive: true, ignoreSigterm: true });
		await expect(
			new AcpRuntimeAdapter(manifest, {
				runner: new FakeRunner(peer),
				terminationGraceMs: 1,
				initializationTimeoutMs: 5,
			}).openSession({ workspace }),
		).rejects.toBeInstanceOf(AcpTransportError);
		expect(peer.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("preserves provider rejections and treats timed-out session creation as unknown", async () => {
		const rejectedPeer = new FakeAcpPeer({ rejectSessionNew: true });
		const rejection = await new AcpRuntimeAdapter(manifest, { runner: new FakeRunner(rejectedPeer) })
			.openSession({ workspace })
			.then(
				() => undefined,
				cause => cause,
			);
		expect(rejection).toBeDefined();
		expect(rejection).not.toBeInstanceOf(AcpUnknownOutcomeError);

		const timedOutPeer = new FakeAcpPeer({ hangOnSessionNew: true });
		await expect(
			new AcpRuntimeAdapter(manifest, {
				runner: new FakeRunner(timedOutPeer),
				initializationTimeoutMs: 5,
			}).openSession({ workspace }),
		).rejects.toBeInstanceOf(AcpUnknownOutcomeError);
	});

	test("rejects malformed ACP frames and preserves an explicit unknown outcome after child exit", async () => {
		await expect(
			new AcpRuntimeAdapter(manifest, {
				runner: new FakeRunner(new FakeAcpPeer({ malformedOnInitialize: true })),
			}).openSession({ workspace }),
		).rejects.toBeInstanceOf(AcpTransportError);

		const peer = new FakeAcpPeer({ closeOnPrompt: true });
		const session = await new AcpRuntimeAdapter(manifest, { runner: new FakeRunner(peer) }).openSession({
			workspace,
		});
		await expect(session.prompt("may have been delivered")).rejects.toBeInstanceOf(AcpUnknownOutcomeError);
		await session.dispose();
		expect(peer.terminated).toBe(1);
	});

	test("rejects duplicate registry IDs and exposes the exact production commands", () => {
		const peer = new FakeAcpPeer();
		const registry = new RuntimeAdapterRegistry(new FakeRunner(peer));
		registry.register(new AcpRuntimeAdapter(manifest, { runner: new FakeRunner(peer) }));
		expect(() => registry.register(new AcpRuntimeAdapter(manifest, { runner: new FakeRunner(peer) }))).toThrow(
			RuntimeAdapterRegistryError,
		);
		const [registered] = registry.list();
		expect(Object.isFrozen(registered)).toBe(true);
		expect(Object.isFrozen(registered?.command)).toBe(true);
		expect(Object.isFrozen(registered?.command.arguments)).toBe(true);
		expect(Object.isFrozen(registered?.capabilities)).toBe(true);
		expect(ACP_RUNTIME_PRESETS.map(preset => preset.command)).toEqual([
			{ executable: "codex-acp", arguments: [] },
			{ executable: "claude-agent-acp", arguments: [] },
			{ executable: "opencode", arguments: ["acp"], cwdArgument: "--cwd" },
		]);
	});
});
