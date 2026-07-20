import type { DesktopRuntimeSnapshot } from "@t4-code/client";

import type { WorkspaceSession } from "../../lib/workspace-data.ts";
import {
  deriveWorkspaceData,
  resolveLiveSession,
  sessionViewId,
} from "../../platform/live-workspace.ts";
import {
  cancelConfirmedAgent,
  type AgentCancelRuntime,
} from "../session-runtime/agent-cancel.ts";
import { sessionWriteLink } from "../session-runtime/session-inventory.ts";
import { readSessionControl } from "../session-runtime/session-observer.ts";
import {
  displayStateFromWire,
  type AgentNode,
  type PaneActionAvailability,
  TERMINAL_AGENT_STATES,
} from "../panes/model.ts";
import { buildAgentTreeRows, type AgentMapState } from "../panes/agent-tree.ts";
import { commandAvailability } from "../panes/live-inspector.ts";
import { agentNodeFromFrame } from "../panes/live-projection.ts";

export interface AgentViewRow {
  readonly node: AgentNode;
  readonly task: string | null;
  readonly resumable: boolean | null;
}

export interface AgentViewGroup {
  readonly viewId: string;
  readonly session: WorkspaceSession;
  readonly projectName: string;
  readonly agents: readonly AgentViewRow[];
}

export type AgentViewFilter = "all" | "active" | "attention" | "finished";

export interface AgentViewDisplayRow extends AgentViewRow {
  readonly depth: number;
  /** Immediate parent context remains visible even when pagination or filtering hides its card. */
  readonly parent: { readonly id: string; readonly title: string } | null;
}

export interface AgentViewDisplayGroup {
  readonly viewId: string;
  readonly session: WorkspaceSession;
  readonly projectName: string;
  readonly agents: readonly AgentViewDisplayRow[];
}

export interface AgentViewSummary {
  readonly sessions: number;
  readonly agents: number;
  readonly running: number;
  readonly attention: number;
  readonly finished: number;
}

export interface AgentViewPage {
  readonly groups: readonly AgentViewDisplayGroup[];
  readonly totalAgents: number;
  readonly visibleAgents: number;
}

/** Failure or stall evidence that merits operator triage. */
export function agentNeedsAttention(row: AgentViewRow): boolean {
  return (
    row.node.state === "failed" ||
    (row.node.evidence !== null && !TERMINAL_AGENT_STATES[row.node.state])
  );
}

export function summarizeAgentView(groups: readonly AgentViewGroup[]): AgentViewSummary {
  let agents = 0;
  let running = 0;
  let attention = 0;
  let finished = 0;
  for (const group of groups) {
    agents += group.agents.length;
    for (const row of group.agents) {
      if (row.node.state === "running") running += 1;
      if (agentNeedsAttention(row)) attention += 1;
      if (TERMINAL_AGENT_STATES[row.node.state]) finished += 1;
    }
  }
  return { sessions: groups.length, agents, running, attention, finished };
}

function matchesFilter(row: AgentViewRow, filter: AgentViewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return agentNeedsAttention(row);
  if (filter === "finished") return TERMINAL_AGENT_STATES[row.node.state];
  return !TERMINAL_AGENT_STATES[row.node.state];
}

function matchesQuery(row: AgentViewRow, query: string): boolean {
  const { node } = row;
  return [
    node.title,
    row.task,
    node.model,
    node.currentTool,
    node.worktree,
    node.path,
    node.evidence,
  ].some((value) => value?.toLowerCase().includes(query) === true);
}

function displayRows(
  rows: readonly AgentViewRow[],
  directMatches: ReadonlySet<string>,
): AgentViewDisplayRow[] {
  const agents: Record<string, AgentNode> = Object.create(null) as Record<string, AgentNode>;
  const byId = new Map<string, AgentViewRow>();
  const order: string[] = [];
  for (const row of rows) {
    agents[row.node.id] = row.node;
    byId.set(row.node.id, row);
    order.push(row.node.id);
  }
  const state: AgentMapState = { agents, order };
  const result: AgentViewDisplayRow[] = [];
  for (const treeRow of buildAgentTreeRows(state)) {
    if (!directMatches.has(treeRow.id)) continue;
    const row = byId.get(treeRow.id);
    if (row === undefined) continue;
    const parentNode =
      row.node.parentId === null ? undefined : byId.get(row.node.parentId)?.node;
    result.push({
      ...row,
      depth: treeRow.depth,
      parent:
        parentNode === undefined ? null : { id: parentNode.id, title: parentNode.title },
    });
  }
  return result;
}

/**
 * Filter loaded agents in stable tree order. Each result carries immediate parent
 * context so hierarchy survives sparse filters and page boundaries without mounting extra cards.
 */
export function filterAgentViewGroups(
  groups: readonly AgentViewGroup[],
  filter: AgentViewFilter,
  rawQuery: string,
): AgentViewDisplayGroup[] {
  const query = rawQuery.trim().toLowerCase();
  const result: AgentViewDisplayGroup[] = [];
  for (const group of groups) {
    const groupMatches =
      query.length > 0 &&
      `${group.session.title}\n${group.session.model}\n${group.projectName}`
        .toLowerCase()
        .includes(query);
    const directMatches = new Set(
      group.agents
        .filter(
          (row) =>
            matchesFilter(row, filter) &&
            (query.length === 0 || groupMatches || matchesQuery(row, query)),
        )
        .map((row) => row.node.id),
    );
    if (directMatches.size === 0) continue;


    result.push({
      viewId: group.viewId,
      session: group.session,
      projectName: group.projectName,
      agents: displayRows(group.agents, directMatches),
    });
  }
  return result;
}
export function pageAgentViewGroups(
  groups: readonly AgentViewDisplayGroup[],
  limit: number,
  offset = 0,
): AgentViewPage {
  const totalAgents = groups.reduce((sum, group) => sum + group.agents.length, 0);
  let remaining = Math.max(0, Math.floor(limit));
  let skipped = Math.max(0, Math.floor(offset));
  const pageGroups: AgentViewDisplayGroup[] = [];
  for (const group of groups) {
    if (remaining === 0) break;
    if (skipped >= group.agents.length) {
      skipped -= group.agents.length;
      continue;
    }
    const agents = group.agents.slice(skipped, skipped + remaining);
    skipped = 0;
    if (agents.length === 0) continue;
    pageGroups.push({ ...group, agents });
    remaining -= agents.length;
  }
  const visibleAgents = pageGroups.reduce((sum, group) => sum + group.agents.length, 0);
  return { groups: pageGroups, totalAgents, visibleAgents };
}

function optionalString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Loaded warm sessions grouped in durable session-list order. */
export function deriveAgentViewGroups(snapshot: DesktopRuntimeSnapshot): AgentViewGroup[] {
  const workspace = deriveWorkspaceData(snapshot);
  const projectById = new Map(workspace.projects.map((project) => [project.id, project]));
  const warmByViewId = new Map(
    [...snapshot.projection.sessions.values()].map((projection) => [
      sessionViewId(String(projection.hostId), String(projection.sessionId)),
      projection,
    ]),
  );
  const groups: AgentViewGroup[] = [];

  for (const session of workspace.sessions) {
    if (session.archivedAt !== undefined) continue;
    const projection = warmByViewId.get(session.id);
    if (projection === undefined || projection.agents.size === 0) continue;
    const agents: AgentViewRow[] = [];
    for (const frame of projection.agents.values()) {
      const detail: Readonly<Record<string, unknown>> = frame.detail ?? {};
      const rawResumable = detail.resumable;
      const id = String(frame.agentId);
      agents.push({
        node: agentNodeFromFrame(frame, projection.events, projection.agentTranscripts.get(id)),
        task: optionalString(detail, "description"),
        resumable: typeof rawResumable === "boolean" ? rawResumable : null,
      });
    }
    groups.push({
      viewId: session.id,
      session,
      projectName: projectById.get(session.projectId)?.name ?? "Unknown project",
      agents,
    });
  }
  return groups;
}

function sessionRevision(snapshot: DesktopRuntimeSnapshot, viewId: string): string | undefined {
  const address = resolveLiveSession(snapshot, viewId);
  if (address === null) return undefined;
  const key = `${address.hostId}\u0000${address.sessionId}`;
  return (
    snapshot.projection.sessions.get(key)?.revision ??
    snapshot.projection.sessionIndex.get(key)?.revision
  );
}

/** Every gate for a destructive Agent View command, from current runtime truth. */
export function agentCancelAvailability(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
  node: AgentNode,
): PaneActionAvailability {
  const address = resolveLiveSession(snapshot, viewId);
  if (address === null) return { enabled: false, reason: "This session host is unavailable." };
  const key = `${address.hostId}\u0000${address.sessionId}`;
  const current = snapshot.projection.sessions.get(key)?.agents.get(node.id);
  if (current === undefined) {
    return { enabled: false, reason: "This agent is no longer available." };
  }
  if (TERMINAL_AGENT_STATES[displayStateFromWire(current.state)]) {
    return { enabled: false, reason: "This agent has already stopped." };
  }
  const available = commandAvailability(snapshot, address.targetId, address.hostId, "agent.cancel");
  if (!available.enabled) return available;
  if (sessionWriteLink(snapshot, address.targetId, address.hostId, address.sessionId) !== "live") {
    return { enabled: false, reason: "This session is still syncing from the host." };
  }
  const ref =
    snapshot.projection.sessions.get(key)?.ref ?? snapshot.projection.sessionIndex.get(key);
  if (readSessionControl(ref) !== null) {
    return { enabled: false, reason: "This session is controlled by another app." };
  }
  if (sessionRevision(snapshot, viewId) === undefined) {
    return { enabled: false, reason: "Waiting for this session's latest state." };
  }
  return { enabled: true, reason: null };
}

export interface AgentViewRuntime extends AgentCancelRuntime {
  getSnapshot(): DesktopRuntimeSnapshot;
}

/** Recheck every gate, then approve the host challenge for this exact cancellation. */
export async function cancelAgentFromView(
  runtime: AgentViewRuntime,
  viewId: string,
  node: AgentNode,
): Promise<void> {
  const snapshot = runtime.getSnapshot();
  const address = resolveLiveSession(snapshot, viewId);
  if (address === null) throw new Error("This session host is unavailable.");

  await cancelConfirmedAgent(runtime, {
    address,
    agentId: node.id,
    assertWritable() {
      const availability = agentCancelAvailability(runtime.getSnapshot(), viewId, node);
      if (!availability.enabled) {
        throw new Error(availability.reason ?? "Agent cancellation is unavailable.");
      }
    },
    currentRevision() {
      const current = sessionRevision(runtime.getSnapshot(), viewId);
      if (current === undefined) throw new Error("Waiting for this session's latest state.");
      return current;
    },
  });
}
