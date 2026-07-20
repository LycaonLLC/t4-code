import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, type ServerFrame } from "@t4-code/host-wire";
import { FileSessionDiscovery } from "../src/discovery.ts";
import { createAppserver } from "../src/server.ts";
import type { RpcChildFactory } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("standard-omp-compatibility-test");
const stamp = "2026-07-20T00:00:00.000Z";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function frameMatching(
  client: RawUdsWebSocket,
  predicate: (frame: ServerFrame) => boolean,
): Promise<ServerFrame> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const frame = await client.nextServer();
          if (predicate(frame)) return frame;
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for compatibility frame")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test("follows standard OMP files while every control path stays disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-standard-omp-compat-"));
  const sessionsRoot = join(root, "sessions");
  const sessionPath = join(sessionsRoot, "standard-session.jsonl");
  const socketPath = join(root, "run", "app.sock");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    sessionPath,
    line({
      type: "session",
      version: 3,
      id: "standard-session",
      cwd: "/tmp/standard",
      timestamp: stamp,
    }) +
      line({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: stamp,
        message: { role: "user", content: "Follow this standard OMP session" },
      }),
  );
  let spawnCalls = 0;
  const childFactory: RpcChildFactory = {
    spawn: () => {
      spawnCalls += 1;
      throw new Error("compatibility mode must not spawn an RPC child");
    },
    argv: () => [],
  };
  const discovery = new FileSessionDiscovery(sessionsRoot, undefined, host, true);
  const appserver = createAppserver({
    hostId: host,
    socketPath,
    discovery,
    readOnlyCompatibility: true,
    discoveryPollMs: 250,
    supportedCapabilities: ["sessions.read"],
    supportedFeatures: ["resume", "session.observer", "transcript.page"],
    childFactory,
  });
  await appserver.start();
  const client = await RawUdsWebSocket.connect(socketPath);
  try {
    client.sendJson({
      v: "omp-app/1",
      type: "hello",
      protocol: { min: "omp-app/1", max: "omp-app/1" },
      client: { name: "compatibility-test", version: "1", build: "test", platform: "darwin" },
      requestedFeatures: ["session.observer", "transcript.page"],
      capabilities: { client: ["sessions.read", "sessions.prompt", "sessions.manage"] },
      savedCursors: [],
    });
    const welcome = await client.nextServer();
    expect(welcome).toMatchObject({
      type: "welcome",
      grantedCapabilities: ["sessions.read"],
      grantedFeatures: ["session.observer", "transcript.page"],
    });
    const sessions = await client.nextServer();
    expect(sessions).toMatchObject({
      type: "sessions",
      sessions: [
        {
          sessionId: "standard-session",
          liveState: { sessionControl: { mode: "compatibility", transcript: "snapshot" } },
        },
      ],
    });

    client.sendJson({
      v: "omp-app/1",
      type: "command",
      requestId: "attach-1",
      commandId: "attach-command",
      hostId: host,
      sessionId: "standard-session",
      command: "session.attach",
      args: {},
    });
    await frameMatching(
      client,
      (frame) => frame.type === "response" && frame.requestId === "attach-1" && frame.ok,
    );

    await appendFile(
      sessionPath,
      line({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-07-20T00:00:01.000Z",
        message: { role: "assistant", content: "Saved output arrived" },
      }),
    );
    const entry = await frameMatching(
      client,
      (frame) => frame.type === "entry" && String(frame.entry.id) === "assistant-1",
    );
    expect(entry).toMatchObject({
      type: "entry",
      entry: { data: { role: "assistant", text: "Saved output arrived" } },
    });

    client.sendJson({
      v: "omp-app/1",
      type: "command",
      requestId: "prompt-1",
      commandId: "prompt-command",
      hostId: host,
      sessionId: "standard-session",
      command: "session.prompt",
      expectedRevision: (sessions as Extract<ServerFrame, { type: "sessions" }>).sessions[0]!
        .revision,
      args: { message: "This must stay disabled" },
    });
    const denied = await frameMatching(
      client,
      (frame) => frame.type === "response" && frame.requestId === "prompt-1",
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "capability_denied" } });
    expect(spawnCalls).toBe(0);
  } finally {
    client.destroy();
    await client.closed();
    await appserver.stop();
    await rm(root, { recursive: true, force: true });
  }
});
