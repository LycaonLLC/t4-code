import { describe, expect, it } from "vite-plus/test";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import type { DesktopRuntimeSnapshot } from "../src/desktop-runtime-contracts.ts";
import {
  ProjectFileSearchError,
  searchProjectFiles,
  type ProjectFileSearchRuntime,
} from "../src/project-file-search.ts";

function snapshot(options: { readonly connected?: boolean; readonly supported?: boolean } = {}) {
  const connected = options.connected !== false;
  return {
    connections: new Map([["target-1", connected ? "connected" : "disconnected"]]),
    targetHosts: new Map([["target-1", "host-1"]]),
    hosts: new Map([
      [
        "host-1",
        {
          targetId: "target-1",
          grantedFeatures: options.supported === false ? [] : ["files.search"],
          grantedCapabilities: ["files.list"],
        },
      ],
    ]),
  } as unknown as DesktopRuntimeSnapshot;
}

class FakeRuntime implements ProjectFileSearchRuntime {
  readonly calls: Array<{ readonly targetId: string; readonly intent: CommandRequest["intent"] }> = [];

  constructor(
    private readonly current: DesktopRuntimeSnapshot,
    private readonly result: CommandResult,
  ) {}

  getSnapshot(): DesktopRuntimeSnapshot {
    return this.current;
  }

  async command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.calls.push({ targetId, intent });
    return this.result;
  }
}

const address = { targetId: "target-1", hostId: "host-1", sessionId: "session-1" };

function accepted(result: unknown): CommandResult {
  return {
    targetId: "target-1",
    requestId: "request-1",
    commandId: "command-1",
    accepted: true,
    result,
  };
}

describe("project file search client", () => {
  it("requires negotiated support and strictly decodes the result", async () => {
    const runtime = new FakeRuntime(
      snapshot(),
      accepted({ matches: [{ path: "src/app.ts" }], truncated: false }),
    );
    await expect(searchProjectFiles(runtime, address, { query: "  app  " })).resolves.toEqual({
      matches: [{ path: "src/app.ts" }],
      truncated: false,
    });
    expect(runtime.calls).toEqual([
      {
        targetId: "target-1",
        intent: {
          hostId: "host-1",
          sessionId: "session-1",
          command: "files.search",
          args: { query: "app" },
        },
      },
    ]);
  });

  it("fails closed while offline, unsupported, or given an invalid host result", async () => {
    const cases = [
      new FakeRuntime(snapshot({ connected: false }), accepted({})),
      new FakeRuntime(snapshot({ supported: false }), accepted({})),
      new FakeRuntime(
        snapshot(),
        accepted({ matches: [{ path: "../secret" }], truncated: false }),
      ),
    ];
    for (const runtime of cases) {
      await expect(searchProjectFiles(runtime, address, { query: "app" })).rejects.toBeInstanceOf(
        ProjectFileSearchError,
      );
    }
    expect(cases[0]?.calls).toHaveLength(0);
    expect(cases[1]?.calls).toHaveLength(0);
  });
});
