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
