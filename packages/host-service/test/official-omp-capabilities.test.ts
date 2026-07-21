import { describe, expect, test } from "bun:test";
import { OPERATION_DISABLED_REASON_CODES, projectId, sessionId } from "@t4-code/host-wire";
import {
  OfficialOmpCapabilityAdapter,
  OfficialOmpOperationError,
} from "../src/official-omp-capabilities.ts";
import { RpcChildSupervisor } from "../src/rpc-child.ts";
import type { ChildHandle, RpcChildFactory, SessionRecord } from "../src/types.ts";

const session: SessionRecord = {
  sessionId: sessionId("capability-session"),
  path: "/tmp/capability-session.jsonl",
  cwd: "/tmp",
  projectId: projectId("capability-project"),
  title: "Capability session",
  updatedAt: "2026-07-20T00:00:00.000Z",
  status: "idle",
  entries: [],
};

describe("official OMP capability adapter", () => {
  test("classifies typed, terminal-only, and unavailable operations before discovery", () => {
    const adapter = new OfficialOmpCapabilityAdapter();
    expect(adapter.assertOperationSupported("session.prompt")).toMatchObject({
      execution: "typed",
      supported: true,
      capabilities: ["sessions.prompt"],
    });
    expect(adapter.operations().find((item) => item.operationId === "slash.plan")).toMatchObject({
      label: "/plan",
      execution: "terminal-only",
      supported: false,
      capabilities: ["sessions.prompt"],
      disabledReason: { code: OPERATION_DISABLED_REASON_CODES.terminalOnly },
    });
    expect(adapter.operations().some((item) => item.operationId === "slash.continue-in-t4")).toBe(
      false,
    );
    expect(() => adapter.assertPromptSupported("/plan implement this")).toThrow(
      OfficialOmpOperationError,
    );
    expect(() => adapter.assertPromptSupported("/q")).toThrow(
      "requires the OMP terminal interface",
    );
    expect(adapter.assertPromptSupported("/unknown remains ordinary prompt text")).toBeUndefined();
    try {
      adapter.assertOperationSupported("goal.create");
      throw new Error("expected unavailable operation rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: OPERATION_DISABLED_REASON_CODES.capabilityUnavailable,
        execution: "unavailable",
        operationId: "goal.create",
      });
    }
  });

  test("normalizes official headless discovery and lets live evidence override the pinned manifest", () => {
    const adapter = new OfficialOmpCapabilityAdapter();
    expect(
      adapter.consume({
        type: "available_commands_update",
        commands: [
          {
            name: "compact",
            aliases: ["c"],
            description: "Compact the session",
            input: { hint: "[focus]" },
            source: "builtin",
          },
          {
            name: "plan",
            description: "Headless plan command supplied by a future OMP",
            source: "extension",
          },
        ],
      }),
    ).toBe(true);
    expect(adapter.assertPromptSupported("/compact now")).toMatchObject({
      operationId: "slash.compact",
      execution: "headless",
      supported: true,
      capabilities: ["sessions.prompt"],
      metadata: { inlineHint: "[focus]" },
    });
    expect(String(adapter.assertPromptSupported("/c now")?.operationId)).toBe("slash.compact");
    expect(adapter.assertPromptSupported("/plan now")).toMatchObject({
      operationId: "slash.plan",
      execution: "headless",
      supported: true,
    });
    expect(adapter.operations().filter((item) => item.operationId === "slash.plan")).toHaveLength(
      1,
    );
  });

  test("withholds pinned terminal rows from unreviewed OMP versions while retaining dispatch guards", () => {
    const adapter = new OfficialOmpCapabilityAdapter("17.1.0");
    expect(adapter.operations().some((item) => item.operationId === "slash.plan")).toBe(false);
    expect(() => adapter.assertPromptSupported("/plan inspect this")).toThrow(
      OfficialOmpOperationError,
    );
  });

  test("lets discovered names and aliases win over pinned terminal aliases", () => {
    const adapter = new OfficialOmpCapabilityAdapter();
    adapter.update([{ name: "status", aliases: ["settings"], source: "extension" }]);
    expect(adapter.operations().filter((item) => item.operationId === "slash.status")).toHaveLength(
      1,
    );
    expect(adapter.operations().some((item) => item.operationId === "slash.settings")).toBe(false);
    expect(adapter.assertPromptSupported("/settings")).toMatchObject({
      operationId: "slash.status",
      execution: "headless",
    });
  });

  test("rejects ambiguous and malformed capability updates", () => {
    const adapter = new OfficialOmpCapabilityAdapter();
    expect(() =>
      adapter.consume({
        type: "available_commands_update",
        commands: [
          { name: "compact", source: "builtin" },
          { name: "compact", source: "extension" },
        ],
      }),
    ).toThrow("duplicate available command");
    expect(() =>
      adapter.consume({
        type: "available_commands_update",
        commands: [{ name: "bad/name", source: "builtin" }],
      }),
    ).toThrow("must be a slash command name");
  });

  test("supervisor queries discovery and blocks terminal-only text before stdin dispatch", async () => {
    const release = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    const capabilityRequest = Promise.withResolvers<Record<string, unknown>>();
    const writes: string[] = [];
    const events: Record<string, unknown>[] = [];
    const child: ChildHandle = {
      stdin: {
        write: (data) => {
          writes.push(data);
          capabilityRequest.resolve(JSON.parse(data) as Record<string, unknown>);
        },
      },
      stdout: (async function* () {
        yield `${JSON.stringify({ type: "ready" })}\n`;
        const request = await capabilityRequest.promise;
        yield `${JSON.stringify({
          type: "response",
          id: request.id,
          command: "get_available_commands",
          success: true,
          data: {
            commands: [{ name: "compact", description: "Compact context", source: "builtin" }],
          },
        })}\n`;
        await release.promise;
      })(),
      stderr: (async function* () {})(),
      exited: exited.promise,
      kill: () => {
        release.resolve();
        exited.resolve(0);
      },
    };
    const factory: RpcChildFactory = {
      spawn: () => child,
      argv: (path) => ["omp", "--mode", "rpc", "--session", path],
    };
    const supervisor = new RpcChildSupervisor(factory, session, {
      entry: () => {},
      event: (frame) => events.push(frame),
      crashed: () => {},
    });
    await supervisor.start();
    await supervisor.refreshOperationCapabilities("capability-query");
    expect(
      supervisor.operationCapabilities().find((item) => item.operationId === "slash.compact"),
    ).toMatchObject({
      execution: "headless",
      supported: true,
    });
    await expect(supervisor.prompt("request", "/plan make a plan")).rejects.toMatchObject({
      code: OPERATION_DISABLED_REASON_CODES.terminalOnly,
      operationId: "slash.plan",
    });
    expect(writes).toHaveLength(1);
    expect(events).toEqual([]);
    supervisor.stop();
    await child.exited;
  });
});
