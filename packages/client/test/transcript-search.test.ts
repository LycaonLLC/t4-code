import { describe, expect, it } from "vite-plus/test";
import { entryId, hostId, projectId, sessionId } from "@t4-code/protocol";
import type { CommandRequest, CommandResult, DesktopTarget } from "@t4-code/protocol/desktop-ipc";
import type {
  DesktopHostMetadata,
  DesktopRuntimeSnapshot,
} from "../src/desktop-runtime-contracts.ts";
import {
  createTranscriptSearchCoordinator,
  MAX_RETAINED_TRANSCRIPT_SEARCH_ITEMS,
  TranscriptSearchError,
  type TranscriptSearchResult,
  type TranscriptSearchRuntime,
} from "../src/transcript-search.ts";

const stamp = "2026-01-01T00:00:00.000Z";

interface HostSpec {
  readonly hostId: string;
  readonly connected?: boolean;
  readonly supported?: boolean;
}

function runtimeSnapshot(hosts: readonly HostSpec[]): DesktopRuntimeSnapshot {
  const targets = new Map<string, DesktopTarget>();
  const connections = new Map<string, DesktopTarget["state"]>();
  const targetHosts = new Map<string, string>();
  const metadata = new Map<string, DesktopHostMetadata>();
  for (const spec of hosts) {
    const targetId = `target-${spec.hostId}`;
    const state = spec.connected === false ? "disconnected" : "connected";
    targets.set(targetId, {
      targetId,
      label: spec.hostId,
      kind: "remote",
      state,
      paired: true,
    });
    connections.set(targetId, state);
    targetHosts.set(targetId, spec.hostId);
    metadata.set(spec.hostId, {
      targetId,
      hostId: spec.hostId,
      ompVersion: "test",
      ompBuild: "test",
      appserverVersion: "test",
      appserverBuild: "test",
      epoch: "epoch-1",
      grantedCapabilities: ["sessions.read"],
      grantedFeatures: spec.supported === false ? [] : ["transcript.search"],
      negotiatedLimits: {},
      authentication: "local",
      resumed: false,
    });
  }
  return {
    version: 1,
    platform: "linux",
    desktopVersion: "test",
    startState: "started",
    targets,
    connections,
    targetHosts,
    hosts: metadata,
    catalogs: new Map(),
    settings: new Map(),
    projection: {
      version: 1,
      hosts: new Map(),
      sessions: new Map(),
      activeSession: undefined,
    },
    runtimeErrors: [],
  } as unknown as DesktopRuntimeSnapshot;
}

function item(
  session: string,
  anchor: string,
  timestamp: string,
  snippet = anchor,
): TranscriptSearchResult["items"][number] {
  return {
    sessionId: sessionId(session),
    projectId: projectId("project-1"),
    sessionTitle: session,
    anchorId: entryId(anchor),
    role: "assistant",
    timestamp,
    snippet,
    highlights: [],
  };
}

function result(
  state: "building" | "ready" | "stale",
  items: TranscriptSearchResult["items"] = [],
  options: { readonly incomplete?: boolean; readonly nextCursor?: string } = {},
): TranscriptSearchResult {
  return {
    items,
    incomplete: options.incomplete ?? state !== "ready",
    ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
    index: {
      state,
      indexedSessions: items.length,
      knownSessions: Math.max(3, items.length),
      generation: `${state}-generation`,
    },
  };
}

class FakeRuntime implements TranscriptSearchRuntime {
  readonly calls: Array<{ readonly targetId: string; readonly intent: CommandRequest["intent"] }> =
    [];
  constructor(
    readonly current: DesktopRuntimeSnapshot,
    readonly handler: (
      targetId: string,
      intent: CommandRequest["intent"],
    ) => Promise<CommandResult>,
  ) {}
  getSnapshot(): DesktopRuntimeSnapshot {
    return this.current;
  }
  async command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.calls.push({ targetId, intent });
    return this.handler(targetId, intent);
  }
}

function accepted(targetId: string, value: unknown): CommandResult {
  return {
    targetId,
    requestId: `request-${targetId}`,
    commandId: `command-${targetId}`,
    accepted: true,
    result: value,
  };
}

describe("cross-host transcript search coordinator", () => {
  it("fans out only to eligible hosts and deterministically merges bounded results", async () => {
    const snapshot = runtimeSnapshot([
      { hostId: "alpha" },
      { hostId: "beta" },
      { hostId: "gamma" },
      { hostId: "delta", supported: false },
      { hostId: "echo", connected: false },
      { hostId: "foxtrot" },
    ]);
    const runtime = new FakeRuntime(snapshot, async (targetId) => {
      if (targetId === "target-alpha") {
        return accepted(
          targetId,
          result("ready", [
            item("alpha-session", "alpha-rank-0", "2026-01-02T00:00:00.000Z"),
            item("alpha-session", "alpha-rank-1", "2026-01-05T00:00:00.000Z"),
          ]),
        );
      }
      if (targetId === "target-beta") {
        return accepted(
          targetId,
          result(
            "stale",
            [
              item("beta-session", "beta-rank-0", "2026-01-03T00:00:00.000Z"),
              item("beta-session", "beta-rank-0", "2026-01-03T00:00:00.000Z"),
            ],
            { nextCursor: "beta-next" },
          ),
        );
      }
      if (targetId === "target-gamma") return accepted(targetId, result("building"));
      throw new Error("host unavailable");
    });
    const coordinator = createTranscriptSearchCoordinator(runtime);

    const searched = await coordinator.search({ query: "  prior decision  ", limit: 10 });

    expect(runtime.calls.map((call) => call.targetId).sort()).toEqual([
      "target-alpha",
      "target-beta",
      "target-foxtrot",
      "target-gamma",
    ]);
    expect(runtime.calls.every((call) => call.intent.command === "transcript.search")).toBe(true);
    expect(runtime.calls.every((call) => call.intent.args?.query === "prior decision")).toBe(true);
    expect(searched.items.map((entry) => `${entry.hostId}:${entry.anchorId}`)).toEqual([
      "beta:beta-rank-0",
      "alpha:alpha-rank-0",
      "alpha:alpha-rank-1",
    ]);
    expect(searched.hosts.get("alpha")?.state).toBe("ready");
    expect(searched.hosts.get("beta")).toMatchObject({ state: "stale", nextCursor: "beta-next" });
    expect(searched.hosts.get("gamma")?.state).toBe("building");
    expect(searched.hosts.get("delta")?.state).toBe("unsupported");
    expect(searched.hosts.get("echo")?.state).toBe("offline");
    expect(searched.hosts.get("foxtrot")).toMatchObject({
      state: "error",
      errorCode: "command_failed",
    });
    expect(searched.incomplete).toBe(true);
    expect("query" in searched).toBe(false);

    const cleared = coordinator.clear();
    expect(cleared.items).toEqual([]);
    expect("query" in cleared).toBe(false);
  });

  it("rejects superseded searches and ignores their late results", async () => {
    const first = Promise.withResolvers<CommandResult>();
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }]),
      async (targetId, intent) => {
        if (intent.args?.query === "first") return first.promise;
        return accepted(
          targetId,
          result("ready", [
            item("new-session", "new-anchor", "2026-01-04T00:00:00.000Z", "new result"),
          ]),
        );
      },
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);

    const staleSearch = coordinator.search({ query: "first" });
    const freshSearch = coordinator.search({ query: "second" });

    await expect(staleSearch).rejects.toMatchObject({ code: "superseded" });
    expect((await freshSearch).items.map((entry) => entry.snippet)).toEqual(["new result"]);
    first.resolve(
      accepted(
        "target-alpha",
        result("ready", [
          item("old-session", "old-anchor", "2026-01-05T00:00:00.000Z", "old result"),
        ]),
      ),
    );
    await Promise.resolve();
    expect(coordinator.getSnapshot().items.map((entry) => entry.snippet)).toEqual(["new result"]);
  });

  it("cancels a pending search without leaving the public state stuck as searching", async () => {
    const pending = Promise.withResolvers<CommandResult>();
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }]),
      async () => pending.promise,
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);

    const search = coordinator.search({ query: "cancel me" });
    coordinator.cancel();

    await expect(search).rejects.toMatchObject({ code: "superseded" });
    expect(coordinator.getSnapshot()).toMatchObject({ searching: false, incomplete: true });
    pending.resolve(accepted("target-alpha", result("ready")));
  });

  it("routes pagination only to the host that issued its cursor and appends unique results", async () => {
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }, { hostId: "beta" }]),
      async (targetId, intent) => {
        if (intent.args?.cursor === "alpha-next") {
          return accepted(
            targetId,
            result("ready", [
              item("alpha-session", "alpha-0", "2026-01-02T00:00:00.000Z"),
              item("alpha-session", "alpha-1", "2026-01-04T00:00:00.000Z"),
            ]),
          );
        }
        if (targetId === "target-alpha") {
          return accepted(
            targetId,
            result("ready", [item("alpha-session", "alpha-0", "2026-01-02T00:00:00.000Z")], {
              nextCursor: "alpha-next",
            }),
          );
        }
        return accepted(
          targetId,
          result("ready", [item("beta-session", "beta-0", "2026-01-03T00:00:00.000Z")], {
            nextCursor: "beta-next",
          }),
        );
      },
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);
    await coordinator.search({ query: "page safely", limit: 2 });

    const paged = await coordinator.loadMore("alpha");

    expect(runtime.calls).toHaveLength(3);
    expect(runtime.calls[2]).toMatchObject({
      targetId: "target-alpha",
      intent: {
        command: "transcript.search",
        args: { query: "page safely", limit: 2, cursor: "alpha-next" },
      },
    });
    expect(paged.items.map((entry) => `${entry.hostId}:${entry.anchorId}`)).toEqual([
      "beta:beta-0",
      "alpha:alpha-0",
      "alpha:alpha-1",
    ]);
    expect(paged.hosts.get("alpha")?.nextCursor).toBeUndefined();
    expect(paged.hosts.get("beta")?.nextCursor).toBe("beta-next");
    await expect(coordinator.loadMore("alpha")).rejects.toMatchObject({
      code: "no_cursor",
      hostId: "alpha",
    });
    expect(runtime.calls).toHaveLength(3);
  });

  it("shows production-sized pages up to the client-wide retention cap", async () => {
    const pageSize = 50;
    const pageItems = (page: number) =>
      Array.from({ length: pageSize }, (_, offset) => {
        const index = page * pageSize + offset;
        return item("long-session", `anchor-${index.toString().padStart(3, "0")}`, stamp);
      });
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }]),
      async (targetId, intent) => {
        const cursor = intent.args?.cursor;
        const page = cursor === undefined ? 0 : Number(String(cursor).replace("cursor-", ""));
        return accepted(
          targetId,
          result("ready", pageItems(page), { nextCursor: `cursor-${page + 1}` }),
        );
      },
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);

    expect(
      (await coordinator.search({ query: "many results", limit: pageSize })).items,
    ).toHaveLength(pageSize);
    await coordinator.loadMore("alpha");
    await coordinator.loadMore("alpha");
    const bounded = await coordinator.loadMore("alpha");

    expect(bounded.items).toHaveLength(MAX_RETAINED_TRANSCRIPT_SEARCH_ITEMS);
    expect(bounded.items.at(-1)?.anchorId).toBe("anchor-199");
    expect(bounded.hosts.get("alpha")?.nextCursor).toBeUndefined();
    await expect(coordinator.loadMore("alpha")).rejects.toMatchObject({ code: "no_cursor" });
    expect(runtime.calls).toHaveLength(4);
  });

  it("stops pagination when a host repeats an opaque cursor", async () => {
    let page = 0;
    const runtime = new FakeRuntime(runtimeSnapshot([{ hostId: "alpha" }]), async (targetId) => {
      const current = page++;
      return accepted(
        targetId,
        result("ready", [item("loop-session", `loop-${current}`, stamp)], {
          nextCursor: "repeated-cursor",
        }),
      );
    });
    const coordinator = createTranscriptSearchCoordinator(runtime);
    await coordinator.search({ query: "cursor loop" });

    const secondPage = await coordinator.loadMore("alpha");

    expect(secondPage.items.map((entry) => entry.anchorId)).toEqual(["loop-0", "loop-1"]);
    expect(secondPage.hosts.get("alpha")?.incomplete).toBe(true);
    expect(secondPage.hosts.get("alpha")?.nextCursor).toBeUndefined();
    await expect(coordinator.loadMore("alpha")).rejects.toMatchObject({ code: "no_cursor" });
    expect(runtime.calls).toHaveLength(2);
  });

  it("rejects a shared cursor before fan-out and ignores pagination completed after clear", async () => {
    const page = Promise.withResolvers<CommandResult>();
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }, { hostId: "beta" }]),
      async (targetId, intent) => {
        if (intent.args?.cursor === "alpha-next") return page.promise;
        return accepted(
          targetId,
          result(
            "ready",
            [item(`${targetId}-session`, `${targetId}-anchor`, stamp)],
            targetId === "target-alpha" ? { nextCursor: "alpha-next" } : {},
          ),
        );
      },
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);

    await expect(
      coordinator.search({ query: "unsafe", cursor: "shared-cursor" }),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    expect(runtime.calls).toHaveLength(0);

    await coordinator.search({ query: "safe" });
    const stalePage = coordinator.loadMore("alpha");
    coordinator.clear();
    await expect(stalePage).rejects.toMatchObject({ code: "superseded" });
    page.resolve(
      accepted(
        "target-alpha",
        result("ready", [item("late-session", "late-anchor", stamp, "late result")]),
      ),
    );
    await Promise.resolve();
    expect(coordinator.getSnapshot().items).toEqual([]);
  });

  it("reads bounded context from the owning host and fails closed for offline hosts", async () => {
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }, { hostId: "offline", connected: false }]),
      async (targetId) =>
        accepted(targetId, {
          anchorId: "anchor-1",
          rows: [
            {
              anchorId: "anchor-1",
              role: "user",
              timestamp: stamp,
              text: "Earlier question",
            },
          ],
          anchorIndex: 0,
          hasBefore: false,
          hasAfter: false,
          generation: "context-generation",
        }),
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);

    const context = await coordinator.context("alpha", "session-1", {
      anchorId: entryId("anchor-1"),
      before: 5,
      after: 5,
    });
    expect(context.rows[0]?.text).toBe("Earlier question");
    expect(runtime.calls[0]).toMatchObject({
      targetId: "target-alpha",
      intent: {
        hostId: hostId("alpha"),
        sessionId: sessionId("session-1"),
        command: "transcript.context",
        args: { anchorId: entryId("anchor-1"), before: 5, after: 5 },
      },
    });

    await expect(
      coordinator.context("offline", "session-1", { anchorId: entryId("anchor-1") }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<TranscriptSearchError>>({
        code: "offline",
        hostId: "offline",
      }),
    );
    expect(runtime.calls).toHaveLength(1);
  });

  it("aborts a context read and ignores its late completion", async () => {
    const pending = Promise.withResolvers<CommandResult>();
    const runtime = new FakeRuntime(
      runtimeSnapshot([{ hostId: "alpha" }]),
      async () => pending.promise,
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);
    const controller = new AbortController();

    const context = coordinator.context(
      "alpha",
      "session-1",
      { anchorId: entryId("anchor-1") },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(context).rejects.toMatchObject({ code: "superseded" });
    pending.resolve(
      accepted("target-alpha", {
        anchorId: "anchor-1",
        rows: [{ anchorId: "anchor-1", role: "assistant", timestamp: stamp, text: "late" }],
        anchorIndex: 0,
        hasBefore: false,
        hasAfter: false,
        generation: "late-generation",
      }),
    );
  });

  it("rejects malformed context results instead of exposing untrusted data", async () => {
    const runtime = new FakeRuntime(runtimeSnapshot([{ hostId: "alpha" }]), async (targetId) =>
      accepted(targetId, {
        anchorId: "anchor-1",
        rows: [{ anchorId: "different", role: "assistant", timestamp: stamp, text: "bad" }],
        anchorIndex: 0,
        hasBefore: false,
        hasAfter: false,
        generation: "context-generation",
      }),
    );
    const coordinator = createTranscriptSearchCoordinator(runtime);

    await expect(
      coordinator.context("alpha", "session-1", { anchorId: entryId("anchor-1") }),
    ).rejects.toMatchObject({ code: "command" });
  });
});
