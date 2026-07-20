// Fixture determinism: every sample timestamp derives from the fixed epoch,
// so two boots produce byte-identical seeds and controller actions land at
// reproducible instants — no module-load wall clock anywhere.
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_VIEW_FIXTURE_GROUPS,
  AGENT_VIEW_FIXTURE_NOW_MS,
} from "../src/features/agent-view/fixtures.ts";
import {
  FIXTURE_EPOCH_MS,
  installFixtureInspector,
} from "../src/features/panes/fixtures.ts";
import { getInspectorStore } from "../src/features/panes/inspector-store.ts";

function snapshot(sessionId: string): string {
  installFixtureInspector();
  const store = getInspectorStore(sessionId);
  if (store === null) throw new Error("fixture factory not installed");
  const state = store.getState();
  return JSON.stringify({
    activity: state.activity,
    agents: state.agentMap,
    review: state.review,
    terminals: state.terminals,
  });
}

describe("fixture determinism", () => {
  it("pins the epoch itself", () => {
    expect(new Date(FIXTURE_EPOCH_MS).toISOString()).toBe("2026-07-11T12:00:00.000Z");
  });

  it("seeds byte-identical state across installs", () => {
    expect(snapshot("sess-stream")).toBe(snapshot("sess-stream"));
    expect(snapshot("sess-settings")).toBe(snapshot("sess-settings"));
  });

  it("derives seed timestamps from the epoch, not the wall clock", () => {
    installFixtureInspector();
    const store = getInspectorStore("sess-stream");
    if (store === null) throw new Error("fixture factory not installed");
    const oldest = store.getState().activity[0];
    // Oldest stream event is minutesAgo(180) from the fixed noon epoch.
    expect(oldest?.at).toBe("2026-07-11T09:00:00.000Z");
  });

  it("controller actions and comments step the injected clock", () => {
    installFixtureInspector();
    const store = getInspectorStore("sess-stream");
    if (store === null) throw new Error("fixture factory not installed");
    const state = store.getState();

    state.requestControl({
      sessionId: "sess-stream",
      agentId: "agent-dedupe",
      agentTitle: "Frame dedupe check",
      action: "wake",
    });
    state.confirmControl();
    const woke = store.getState().activity.at(-1);
    expect(woke?.at).toBe("2026-07-11T12:00:01.000Z");

    state.addComment("packages/client/src/replay.ts", 130, "new", "fence note");
    const comment = store.getState().review.comments.at(-1);
    expect(comment?.at).toBe("2026-07-11T12:00:02.000Z");
  });

  it("backs sample file drafts with a stable synthetic revision", async () => {
    installFixtureInspector();
    const store = getInspectorStore("sess-stream");
    if (store === null) throw new Error("fixture factory not installed");
    const path = "packages/client/src/replay.ts";

    store.getState().selectFile(path);
    await Promise.resolve();
    store.getState().startFileEdit(path);

    expect(store.getState().files.draftsByPath[path]?.baseRevision).toBe("fixture-revision-1");
  });
});

describe("global Agent View fixtures", () => {
  it("exposes deterministic multi-session lifecycle samples", () => {
    expect(AGENT_VIEW_FIXTURE_NOW_MS).toBe(FIXTURE_EPOCH_MS);
    expect(AGENT_VIEW_FIXTURE_GROUPS.map(({ viewId }) => viewId)).toEqual([
      "sess-stream",
      "sess-bundle",
    ]);

    const agents = AGENT_VIEW_FIXTURE_GROUPS.flatMap(({ agents }) => agents);
    expect(agents).toHaveLength(11);
    expect(new Set(agents.map(({ node }) => node.state))).toEqual(
      new Set(["running", "waiting", "parked", "completed", "failed", "queued"]),
    );
    expect(agents.some(({ node }) => node.path === "packages/client/src/replay.ts")).toBe(true);
    expect(agents.find(({ node }) => node.state === "parked")?.resumable).toBe(true);
  });
});
