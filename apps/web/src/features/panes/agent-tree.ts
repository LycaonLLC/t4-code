// Agent tree derivation: flat wire updates in, a stable parent/child render
// order out. Row identity is the agent id, so progress updates replace one
// node object and re-render one row — never the whole tree.
import {
  type AgentDisplayState,
  type AgentNode,
  TERMINAL_AGENT_STATES,
} from "./model.ts";

export interface AgentTreeRow {
  readonly id: string;
  readonly depth: number;
}

export interface AgentMapState {
  readonly agents: Readonly<Record<string, AgentNode>>;
  /** First-seen order; the tree keeps arrival order within a parent. */
  readonly order: readonly string[];
}

export const EMPTY_AGENT_MAP: AgentMapState = { agents: {}, order: [] };

/**
 * Depth-first render order: roots in arrival order, each followed by its
 * descendants (arrival order within a parent). Orphans — children whose
 * parent is unknown — surface at the root rather than vanishing.
 */
export function buildAgentTreeRows(state: AgentMapState): AgentTreeRow[] {
  const childrenByParent = buildChildrenByParent(state);
  const rows: AgentTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (startId: string, depth: number) => {
    const stack: Array<{ id: string; depth: number }> = [{ id: startId, depth }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || visited.has(current.id)) continue;
      visited.add(current.id);
      rows.push({ id: current.id, depth: current.depth });
      const children = childrenByParent.get(current.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childId = children[index];
        if (childId !== undefined) stack.push({ id: childId, depth: current.depth + 1 });
      }
    }
  };
  for (const id of childrenByParent.get(null) ?? []) visit(id, 0);
  for (const id of state.order) {
    if (state.agents[id] !== undefined && !visited.has(id)) visit(id, 0);
  }
  return rows;
}

function buildChildrenByParent(state: AgentMapState): Map<string | null, string[]> {
  const childrenByParent = new Map<string | null, string[]>();
  for (const id of state.order) {
    const node = state.agents[id];
    if (node === undefined) continue;
    const parentKey =
      node.parentId !== null && state.agents[node.parentId] !== undefined ? node.parentId : null;
    const siblings = childrenByParent.get(parentKey);
    if (siblings === undefined) childrenByParent.set(parentKey, [id]);
    else siblings.push(id);
  }
  return childrenByParent;
}

function collectDescendants(state: AgentMapState, rootId: string): string[] {
  const childrenByParent = buildChildrenByParent(state);
  const result: string[] = [];
  const visited = new Set<string>([rootId]);
  const queue = [...(childrenByParent.get(rootId) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    queue.push(...(childrenByParent.get(id) ?? []));
  }
  return result;
}

/** Insert or update one agent; unknown ids append to arrival order. */
export function upsertAgent(state: AgentMapState, node: AgentNode): AgentMapState {
  const known = state.agents[node.id] !== undefined;
  return {
    agents: { ...state.agents, [node.id]: node },
    order: known ? state.order : [...state.order, node.id],
  };
}

/** Patch fields on one agent without touching any other node object. */
export function patchAgent(
  state: AgentMapState,
  id: string,
  patch: Partial<AgentNode>,
): AgentMapState {
  const current = state.agents[id];
  if (current === undefined) return state;
  return { agents: { ...state.agents, [id]: { ...current, ...patch } }, order: state.order };
}

/**
 * When a parent reaches a terminal state, descendants still in a live state
 * are stale: the runtime will never finish them. Mark them aborted with
 * explicit evidence instead of leaving a lying "running" row behind.
 */
export function clearStaleChildren(state: AgentMapState, parentId: string): AgentMapState {
  const parent = state.agents[parentId];
  if (parent === undefined || !TERMINAL_AGENT_STATES[parent.state]) return state;
  const staleIds = collectDescendants(state, parentId).filter((id) => {
    const node = state.agents[id];
    return node !== undefined && !TERMINAL_AGENT_STATES[node.state];
  });
  if (staleIds.length === 0) return state;
  const agents = { ...state.agents };
  for (const id of staleIds) {
    const node = agents[id];
    if (node === undefined) continue;
    agents[id] = {
      ...node,
      state: "aborted",
      progress: null,
      evidence: `Parent agent ended (${parent.state}) before this agent reported an end state.`,
    };
  }
  return { agents, order: state.order };
}

/** Remove an agent and its whole subtree (e.g. runtime dropped the batch). */
export function removeAgentSubtree(state: AgentMapState, id: string): AgentMapState {
  if (state.agents[id] === undefined) return state;
  const doomed = new Set<string>([id, ...collectDescendants(state, id)]);
  const agents: Record<string, AgentNode> = {};
  for (const [agentId, node] of Object.entries(state.agents)) {
    if (!doomed.has(agentId)) agents[agentId] = node;
  }
  return { agents, order: state.order.filter((agentId) => !doomed.has(agentId)) };
}


/** Wall-clock elapsed label for a live agent row ("3m 12s", "1h 4m"). */
export function formatElapsed(startedAt: string | null, nowMs: number): string {
  if (startedAt === null) return "";
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs) || nowMs < startMs) return "";
  const totalSeconds = Math.floor((nowMs - startMs) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** The label/status style pairing for each display state (token classes only). */
export const AGENT_STATE_STYLES: Readonly<
  Record<AgentDisplayState, { label: string; dotClass: string; textClass: string; pulse: boolean }>
> = {
  queued: {
    label: "Queued",
    dotClass: "bg-muted-foreground/50",
    textClass: "text-muted-foreground",
    pulse: false,
  },
  running: {
    label: "Running",
    dotClass: "bg-status-working-dot",
    textClass: "text-status-working",
    pulse: true,
  },
  waiting: {
    label: "Waiting",
    dotClass: "bg-status-input-dot",
    textClass: "text-status-input",
    pulse: false,
  },
  idle: {
    label: "Idle",
    dotClass: "bg-muted-foreground/70",
    textClass: "text-muted-foreground",
    pulse: false,
  },
  parked: {
    label: "Parked",
    dotClass: "border border-muted-foreground/70 bg-transparent",
    textClass: "text-muted-foreground",
    pulse: false,
  },
  completed: {
    label: "Completed",
    dotClass: "bg-status-done-dot",
    textClass: "text-status-done",
    pulse: false,
  },
  failed: {
    label: "Failed",
    dotClass: "bg-status-error-dot",
    textClass: "text-status-error",
    pulse: false,
  },
  aborted: {
    label: "Aborted",
    dotClass: "bg-status-error-dot/70",
    textClass: "text-status-error",
    pulse: false,
  },
};
