import { describe, expect, it } from "vite-plus/test";
import { entryId, hostId, sessionId } from "@t4-code/protocol";
import type { CommandRequest, CommandResult, DesktopTarget } from "@t4-code/protocol/desktop-ipc";
import type {
  DesktopHostMetadata,
  DesktopRuntimeSnapshot,
} from "../src/desktop-runtime-contracts.ts";
import { readTranscriptPage, type TranscriptPageRuntime } from "../src/transcript-page.ts";

const address = {
  targetId: "target-a",
  hostId: "host-a",
  sessionId: "session-a",
};

function runtimeSnapshot(
  options: {
    readonly connected?: boolean;
    readonly supported?: boolean;
  } = {},
): DesktopRuntimeSnapshot {
  const state = options.connected === false ? "disconnected" : "connected";
  const target: DesktopTarget = {
    targetId: address.targetId,
    label: "Host A",
    kind: "remote",
    state,
    paired: true,
  };
  const metadata: DesktopHostMetadata = {
    targetId: address.targetId,
    hostId: address.hostId,
    ompVersion: "test",
    ompBuild: "test",
    appserverVersion: "test",
    appserverBuild: "test",
    epoch: "epoch-a",
    grantedCapabilities: ["sessions.read"],
    grantedFeatures: options.supported === false ? [] : ["transcript.page"],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
  return {
    version: 1,
    integration: {} as DesktopRuntimeSnapshot["integration"],
    platform: "linux",
    desktopVersion: "test",
    startState: "started",
    targets: new Map([[address.targetId, target]]),
    connections: new Map([[address.targetId, state]]),
    targetHosts: new Map([[address.targetId, address.hostId]]),
    hosts: new Map([[address.hostId, metadata]]),
    catalogs: new Map(),
    settings: new Map(),
    projection: {
      version: 1,
      hosts: new Map(),
      sessions: new Map(),
      activeSession: undefined,
    } as unknown as DesktopRuntimeSnapshot["projection"],
    runtimeErrors: [],
  };
}

class FakeRuntime implements TranscriptPageRuntime {
  readonly calls: Array<{ readonly targetId: string; readonly intent: CommandRequest["intent"] }> =
    [];

  constructor(
    readonly snapshot: DesktopRuntimeSnapshot,
    readonly result: CommandResult,
  ) {}

  getSnapshot(): DesktopRuntimeSnapshot {
    return this.snapshot;
  }

  async command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.calls.push({ targetId, intent });
    return this.result;
  }
}

function accepted(result: unknown): CommandResult {
  return {
    targetId: address.targetId,
    requestId: "request-a",
    commandId: "command-a",
    accepted: true,
    result,
  };
}

function rejected(code: string): CommandResult {
  return {
    targetId: address.targetId,
    requestId: "request-a",
    commandId: "command-a",
    accepted: false,
    error: { code, message: code },
  };
}

const pageEntry = {
  id: entryId("entry-a"),
  parentId: null,
  hostId: hostId(address.hostId),
  sessionId: sessionId(address.sessionId),
  kind: "message" as const,
  timestamp: "2026-07-20T00:00:00.000Z",
  data: { role: "assistant", text: "Tail first" },
};

describe("bounded transcript page client", () => {
  it("issues a read-only page command and decodes its result", async () => {
    const runtime = new FakeRuntime(
      runtimeSnapshot(),
      accepted({
        entries: [pageEntry],
        nextCursor: "opaque-page-1",
        hasMore: true,
        generation: "generation-a",
      }),
    );

    const page = await readTranscriptPage(runtime, address, { limit: 32, maxBytes: 64 * 1024 });

    expect(page.entries).toEqual([pageEntry]);
    expect(runtime.calls).toEqual([
      {
        targetId: address.targetId,
        intent: {
          hostId: hostId(address.hostId),
          sessionId: sessionId(address.sessionId),
          command: "transcript.page",
          args: { limit: 32, maxBytes: 64 * 1024 },
        },
      },
    ]);
  });

  it("does not send requests to offline or unsupported hosts", async () => {
    for (const [snapshot, code] of [
      [runtimeSnapshot({ connected: false }), "offline"],
      [runtimeSnapshot({ supported: false }), "unsupported"],
    ] as const) {
      const runtime = new FakeRuntime(snapshot, accepted({}));
      await expect(readTranscriptPage(runtime, address)).rejects.toMatchObject({ code });
      expect(runtime.calls).toHaveLength(0);
    }
  });

  it("keeps stale history cursors distinct from malformed responses", async () => {
    const stale = new FakeRuntime(runtimeSnapshot(), rejected("transcript_cursor_stale"));
    await expect(readTranscriptPage(stale, address, { before: "old-page" })).rejects.toMatchObject({
      code: "stale",
      remoteCode: "transcript_cursor_stale",
    });

    const malformed = new FakeRuntime(runtimeSnapshot(), accepted({ entries: [] }));
    await expect(readTranscriptPage(malformed, address)).rejects.toMatchObject({
      code: "command",
      remoteCode: "invalid_result",
    });
  });

  it("rejects invalid bounds before crossing the runtime boundary", async () => {
    const runtime = new FakeRuntime(runtimeSnapshot(), accepted({}));
    await expect(readTranscriptPage(runtime, address, { limit: 0 })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(runtime.calls).toHaveLength(0);
  });
});
