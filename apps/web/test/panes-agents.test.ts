// Agent tree contract: lifecycle transitions, render order, stale-child
// clearing, and subtree removal — the invariants the Agents pane sells.
import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentTreeRows,
  clearStaleChildren,
  EMPTY_AGENT_MAP,
  formatElapsed,
  patchAgent,
  removeAgentSubtree,
  upsertAgent,
} from "../src/features/panes/agent-tree.ts";
import { displayStateFromWire, type AgentNode } from "../src/features/panes/model.ts";

function node(partial: Partial<AgentNode> & Pick<AgentNode, "id">): AgentNode {
  return {
    parentId: null,
    title: partial.id,
    kind: "agent",
    state: "running",
    progress: null,
    startedAt: null,
    lastActivityAt: null,
    model: null,
    worktree: null,
    path: null,
    currentTool: null,
    contextUsed: null,
    contextLimit: null,
    evidence: null,
    transcriptEntries: [],
    transcriptReceived: false,
    transcriptFreshness: "fresh",
    transcriptHistoryTruncated: false,
    transcript: [],
    ...partial,
  };
}

function buildMap(...nodes: AgentNode[]) {
  let state = EMPTY_AGENT_MAP;
  for (const entry of nodes) state = upsertAgent(state, entry);
  return state;
}

describe("agent tree order", () => {
  it("renders parent, batch, grandchild depth-first in arrival order", () => {
    const state = buildMap(
      node({ id: "main" }),
      node({ id: "batch", parentId: "main", kind: "batch" }),
      node({ id: "child-a", parentId: "batch" }),
      node({ id: "grandchild", parentId: "child-a" }),
      node({ id: "child-b", parentId: "batch" }),
      node({ id: "sibling", parentId: "main" }),
    );
    expect(buildAgentTreeRows(state)).toEqual([
      { id: "main", depth: 0 },
      { id: "batch", depth: 1 },
      { id: "child-a", depth: 2 },
      { id: "grandchild", depth: 3 },
      { id: "child-b", depth: 2 },
      { id: "sibling", depth: 1 },
    ]);
  });

  it("keeps arrival order stable when an existing agent is updated", () => {
    let state = buildMap(node({ id: "a" }), node({ id: "b" }));
    state = upsertAgent(state, node({ id: "a", state: "completed" }));
    expect(buildAgentTreeRows(state).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("surfaces orphans (unknown parent) at the root instead of hiding them", () => {
    const state = buildMap(node({ id: "lost", parentId: "never-seen" }));
    expect(buildAgentTreeRows(state)).toEqual([{ id: "lost", depth: 0 }]);
  });

  it("terminates and emits every node for self and multi-node cycles", () => {
    const state = buildMap(
      node({ id: "self", parentId: "self" }),
      node({ id: "cycle-a", parentId: "cycle-b" }),
      node({ id: "cycle-b", parentId: "cycle-a" }),
      node({ id: "descendant", parentId: "cycle-a" }),
    );
    expect(buildAgentTreeRows(state)).toEqual([
      { id: "self", depth: 0 },
      { id: "cycle-a", depth: 0 },
      { id: "cycle-b", depth: 1 },
      { id: "descendant", depth: 1 },
    ]);
  });

  it("completes a large deep hierarchy without recursive stack overflow", () => {
    const agents: Record<string, AgentNode> = {};
    const order: string[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const id = `agent-${index}`;
      agents[id] = node({ id, parentId: index === 0 ? null : `agent-${index - 1}` });
      order.push(id);
    }
    const rows = buildAgentTreeRows({ agents, order });
    expect(rows).toHaveLength(10_000);
    expect(rows[0]).toEqual({ id: "agent-0", depth: 0 });
    expect(rows[9_999]).toEqual({ id: "agent-9999", depth: 9_999 });
  }, 10_000);
});

describe("agent lifecycle", () => {
  it("folds open wire states into the fixed display set", () => {
    expect(displayStateFromWire("started")).toBe("running");
    expect(displayStateFromWire("cancelled")).toBe("aborted");
    expect(displayStateFromWire("parked")).toBe("parked");
    expect(displayStateFromWire("some-future-state")).toBe("queued");
  });

  it("patching one agent leaves every other node object identical", () => {
    const state = buildMap(node({ id: "a" }), node({ id: "b" }));
    const next = patchAgent(state, "a", { progress: 0.5 });
    expect(next.agents.a?.progress).toBe(0.5);
    expect(next.agents.b).toBe(state.agents.b);
    expect(next.order).toBe(state.order);
  });
});

describe("stale child clearing", () => {
  it("marks live descendants aborted with evidence when the parent ends", () => {
    let state = buildMap(
      node({ id: "batch", state: "running" }),
      node({ id: "child", parentId: "batch", state: "running" }),
      node({ id: "grandchild", parentId: "child", state: "waiting" }),
      node({ id: "done-child", parentId: "batch", state: "completed" }),
    );
    state = patchAgent(state, "batch", { state: "failed" });
    state = clearStaleChildren(state, "batch");
    expect(state.agents.child?.state).toBe("aborted");
    expect(state.agents.child?.evidence).toContain("failed");
    expect(state.agents.grandchild?.state).toBe("aborted");
    // Already-finished children keep their real outcome.
    expect(state.agents["done-child"]?.state).toBe("completed");
  });

  it("does nothing while the parent is still live", () => {
    const state = buildMap(
      node({ id: "batch", state: "running" }),
      node({ id: "child", parentId: "batch", state: "running" }),
    );
    expect(clearStaleChildren(state, "batch")).toBe(state);
  });

  it("removes a whole subtree when the runtime drops an agent", () => {
    const state = buildMap(
      node({ id: "main" }),
      node({ id: "batch", parentId: "main" }),
      node({ id: "child", parentId: "batch" }),
    );
    const next = removeAgentSubtree(state, "batch");
    expect(Object.keys(next.agents)).toEqual(["main"]);
    expect(next.order).toEqual(["main"]);
  });
});

describe("elapsed formatting", () => {
  it("scales seconds → minutes → hours", () => {
    const start = new Date(0).toISOString();
    expect(formatElapsed(start, 42_000)).toBe("42s");
    expect(formatElapsed(start, 3 * 60_000 + 12_000)).toBe("3m 12s");
    expect(formatElapsed(start, 64 * 60_000)).toBe("1h 4m");
    expect(formatElapsed(null, 1_000)).toBe("");
  });
});
