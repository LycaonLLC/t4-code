import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, projectId, sessionId, type ServerFrame } from "@t4-code/host-wire";
import { createAppserver } from "../src/server.ts";
import type { ChildHandle, RpcChildFactory, SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

async function responseFor(
  client: RawUdsWebSocket,
  expectedRequestId: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
  for (;;) {
    const frame = await client.nextServer();
    if (frame.type === "response" && frame.requestId === expectedRequestId) return frame;
  }
}

class CapabilityRpcChild implements ChildHandle {
  readonly writes: Record<string, unknown>[] = [];
  readonly #exit = Promise.withResolvers<number>();
  #stdoutController?: ReadableStreamDefaultController<string>;
  #stderrController?: ReadableStreamDefaultController<string>;
  #closed = false;
  readonly exited = this.#exit.promise;
  readonly stdout = new ReadableStream<string>({
    start: (controller) => {
      this.#stdoutController = controller;
      controller.enqueue(`${JSON.stringify({ type: "ready" })}\n`);
    },
  }) as unknown as AsyncIterable<string>;
  readonly stderr = new ReadableStream<string>({
    start: (controller) => {
      this.#stderrController = controller;
    },
  }) as unknown as AsyncIterable<string>;
  readonly stdin = {
    write: (data: string): void => {
      const command = JSON.parse(data) as Record<string, unknown>;
      this.writes.push(command);
      const id = command.id;
      if (command.type === "get_state")
        this.push({
          type: "response",
          id,
          command: "get_state",
          success: true,
          data: {
            isStreaming: false,
            isCompacting: false,
            isPaused: false,
            messageCount: 0,
            queuedMessageCount: 0,
            steeringMode: "all",
            followUpMode: "all",
            interruptMode: "immediate",
          },
        });
      else if (command.type === "get_available_commands")
        this.push({
          type: "response",
          id,
          command: "get_available_commands",
          success: true,
          data: {
            commands: [
              {
                name: "compact",
                description: "Compact the session context",
                source: "builtin",
              },
            ],
          },
        });
    },
  };

  push(frame: Record<string, unknown>): void {
    this.#stdoutController?.enqueue(`${JSON.stringify(frame)}\n`);
  }

  kill(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stdoutController?.close();
    this.#stderrController?.close();
    this.#exit.resolve(0);
  }
}

class CapabilityRpcFactory implements RpcChildFactory {
  readonly children: CapabilityRpcChild[] = [];

  spawn(): ChildHandle {
    const child = new CapabilityRpcChild();
    this.children.push(child);
    return child;
  }

  argv(path: string): string[] {
    return ["omp", "--mode", "rpc", "--session", path];
  }
}

test("catalog.get merges normalized official OMP operation capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-official-omp-catalog-"));
  const socketPath = join(root, "run", "app.sock");
  const host = hostId("official-omp-catalog-host");
  const appserver = createAppserver({
    hostId: host,
    socketPath,
    ompVersion: "17.0.6",
    discovery: { list: async () => [] },
    operationsAuthority: {
      catalogGet: async () => ({
        revision: "authority-revision",
        items: [],
        operations: [
          {
            operationId: "goal.create",
            label: "Create goal",
            execution: "unavailable",
            supported: false,
            disabledReason: {
              code: "capability_unavailable",
              message: "Goal mode is unavailable.",
            },
          },
          {
            operationId: "slash.plan",
            label: "/plan",
            execution: "headless",
            supported: true,
          },
        ],
      }),
    },
  });
  await appserver.start();
  const client = await RawUdsWebSocket.connect(socketPath);
  try {
    client.sendJson({
      v: "omp-app/1",
      type: "hello",
      protocol: { min: "omp-app/1", max: "omp-app/1" },
      client: { name: "catalog-test", version: "1", build: "test", platform: "linux" },
      requestedFeatures: [],
      capabilities: { client: ["catalog.read"] },
      savedCursors: [],
    });
    expect(await client.nextServer()).toMatchObject({
      type: "welcome",
      grantedCapabilities: ["catalog.read"],
    });
    expect((await client.nextServer()).type).toBe("sessions");

    client.sendJson({
      v: "omp-app/1",
      type: "command",
      requestId: "catalog-request",
      commandId: "catalog-command",
      hostId: host,
      command: "catalog.get",
      args: {},
    });
    const response = await responseFor(client, "catalog-request");
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("catalog request failed");
    const result = response.result as {
      revision: string;
      operations: Array<{ operationId: string; execution: string; supported: boolean }>;
    };
    expect(result.revision).toMatch(/^capabilities-[0-9a-f]{64}$/u);
    expect(result.operations.find((item) => item.operationId === "session.prompt")).toMatchObject({
      execution: "typed",
      supported: true,
    });
    expect(result.operations.find((item) => item.operationId === "slash.plan")).toMatchObject({
      execution: "terminal-only",
      supported: false,
    });
    expect(result.operations.find((item) => item.operationId === "goal.create")).toMatchObject({
      execution: "unavailable",
      supported: false,
    });
  } finally {
    client.destroy();
    await client.closed();
    await appserver.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("attached catalog refresh and terminal-only rejection stay on the runtime boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-official-omp-live-catalog-"));
  const socketPath = join(root, "run", "app.sock");
  const host = hostId("official-omp-live-catalog-host");
  const session: SessionRecord = {
    sessionId: sessionId("official-omp-live-session"),
    path: join(root, "session.jsonl"),
    cwd: root,
    projectId: projectId("official-omp-live-project"),
    title: "Live capability session",
    updatedAt: "2026-07-20T00:00:00.000Z",
    status: "idle",
    entries: [],
  };
  const factory = new CapabilityRpcFactory();
  const appserver = createAppserver({
    hostId: host,
    socketPath,
    ompVersion: "17.0.6",
    discovery: { list: async () => [session] },
    childFactory: factory,
    lockCheck: () => {},
    lockStatus: () => "missing",
    operationsAuthority: {
      catalogGet: async () => ({ revision: "authority-revision", items: [] }),
    },
  });
  await appserver.start();
  const client = await RawUdsWebSocket.connect(socketPath);
  try {
    client.sendJson({
      v: "omp-app/1",
      type: "hello",
      protocol: { min: "omp-app/1", max: "omp-app/1" },
      client: { name: "live-catalog-test", version: "1", build: "test", platform: "linux" },
      requestedFeatures: [],
      capabilities: { client: ["sessions.read", "sessions.prompt", "catalog.read"] },
      savedCursors: [],
    });
    expect(await client.nextServer()).toMatchObject({
      type: "welcome",
      grantedCapabilities: ["sessions.read", "sessions.prompt", "catalog.read"],
    });
    expect((await client.nextServer()).type).toBe("sessions");
    let commandOrdinal = 0;
    const sendCommand = (
      request: string,
      command: string,
      args: Record<string, unknown>,
      options: { session?: boolean; expectedRevision?: string } = {},
    ): void => {
      commandOrdinal += 1;
      client.sendJson({
        v: "omp-app/1",
        type: "command",
        requestId: request,
        commandId: `live-command-${commandOrdinal}`,
        hostId: host,
        ...(options.session === false ? {} : { sessionId: session.sessionId }),
        command,
        ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
        args,
      });
    };

    sendCommand("state", "session.state.get", {});
    expect(await responseFor(client, "state")).toMatchObject({ ok: true });
    expect(factory.children).toHaveLength(1);
    sendCommand("attach", "session.attach", {});
    expect(await responseFor(client, "attach")).toMatchObject({ ok: true });

    sendCommand("catalog", "catalog.get", {}, { session: false });
    const catalogResponse = await responseFor(client, "catalog");
    expect(catalogResponse.ok).toBe(true);
    if (!catalogResponse.ok) throw new Error("catalog refresh failed");
    const catalog = catalogResponse.result as {
      operations: Array<{ operationId: string; execution: string; supported: boolean }>;
    };
    expect(catalog.operations.find((item) => item.operationId === "slash.compact")).toMatchObject({
      execution: "headless",
      supported: true,
    });
    expect(catalog.operations.find((item) => item.operationId === "slash.plan")).toMatchObject({
      execution: "terminal-only",
      supported: false,
    });

    sendCommand("plan", "session.prompt", { message: "/plan implement this" });
    expect(await responseFor(client, "plan")).toMatchObject({
      ok: false,
      error: {
        code: "terminal_only",
        message: "/plan requires the OMP terminal interface.",
        details: { operationId: "slash.plan", execution: "terminal-only" },
      },
    });
    const rpcCommandTypes = factory.children[0]?.writes.map((command) => command.type) ?? [];
    expect(rpcCommandTypes.slice(0, 2)).toEqual(["get_state", "get_available_commands"]);
    expect(rpcCommandTypes).not.toContain("prompt");
  } finally {
    client.destroy();
    await client.closed();
    await appserver.stop();
    await rm(root, { recursive: true, force: true });
  }
});
