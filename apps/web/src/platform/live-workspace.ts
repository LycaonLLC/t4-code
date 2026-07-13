// Live workspace projection: folds a DesktopRuntimeSnapshot into the display
// shapes the rail, palette, and session header render. Pure derivation from
// protocol truth — session refs, host metadata, connection states — with no
// fixture reads and no invented data. Remote absolute paths never surface;
// projects display their advertised name or a basename.
import type { DesktopRuntimeSnapshot, SessionProjection } from "@t4-code/client";
import type { SessionStatus } from "@t4-code/ui";

import type {
  WorkspaceData,
  WorkspaceHost,
  WorkspaceProject,
  WorkspaceSession,
} from "../lib/workspace-data.ts";

/** Composite route id for one live session; unambiguous and URL-safe. */
export function sessionViewId(hostId: string, sessionId: string): string {
  return `${encodeURIComponent(hostId)}/${encodeURIComponent(sessionId)}`;
}

export interface LiveSessionAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

/** Resolve a session view id back to its target/host/session triple. */
export function resolveLiveSession(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
): LiveSessionAddress | null {
  const separator = viewId.indexOf("/");
  if (separator <= 0) return null;
  const hostId = decodeURIComponent(viewId.slice(0, separator));
  const sessionId = decodeURIComponent(viewId.slice(separator + 1));
  for (const [targetId, boundHost] of snapshot.targetHosts) {
    if (boundHost === hostId) return { targetId, hostId, sessionId };
  }
  return null;
}

/** Composite route id for one live project. */
export interface LiveProjectAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly projectId: string;
}

/** Resolve a project view id, rejecting malformed ids and unbound hosts. */
export function resolveLiveProject(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
): LiveProjectAddress | null {
  const separator = viewId.indexOf("/");
  if (separator <= 0 || separator !== viewId.lastIndexOf("/") || separator === viewId.length - 1) {
    return null;
  }
  try {
    const hostId = decodeURIComponent(viewId.slice(0, separator));
    const projectId = decodeURIComponent(viewId.slice(separator + 1));
    if (hostId === "" || projectId === "") return null;
    for (const [targetId, boundHost] of snapshot.targetHosts) {
      if (boundHost === hostId) return { targetId, hostId, projectId };
    }
  } catch {
    return null;
  }
  return null;
}
/** Warm per-session projection for a view id, when the runtime holds one. */
export function warmSessionProjection(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
  sessionId: string,
): SessionProjection | undefined {
  return snapshot.projection.sessions.get(`${hostId}\u0000${sessionId}`);
}

/** Display name for a project: advertised name, else the id's basename. */
function projectDisplayName(project: { readonly projectId: string; readonly name?: string }): string {
  if (project.name !== undefined && project.name !== "") return project.name;
  const id = String(project.projectId);
  const segments = id.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.at(-1) ?? id;
}

function hostConnection(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
): { readonly targetId: string | null; readonly state: string | null } {
  for (const [targetId, boundHost] of snapshot.targetHosts) {
    if (boundHost === hostId) {
      return { targetId, state: snapshot.connections.get(targetId) ?? null };
    }
  }
  return { targetId: null, state: null };
}

const derived = new WeakMap<DesktopRuntimeSnapshot, WorkspaceData>();

const EMPTY_WORKSPACE: WorkspaceData = Object.freeze({
  hosts: Object.freeze([]),
  projects: Object.freeze([]),
  sessions: Object.freeze([]),
});

/**
 * Derive the display workspace from a runtime snapshot. Referentially
 * stable per snapshot so memoized consumers skip unchanged derivations.
 */
export function deriveWorkspaceData(snapshot: DesktopRuntimeSnapshot): WorkspaceData {
  const cached = derived.get(snapshot);
  if (cached !== undefined) return cached;

  const hosts: WorkspaceHost[] = [];
  for (const [hostId, meta] of snapshot.hosts) {
    const target = snapshot.targets.get(meta.targetId);
    hosts.push({
      id: hostId,
      name: target?.label ?? "This machine",
      kind: target?.kind ?? "local",
    });
  }

  const projects = new Map<string, WorkspaceProject>();
  const projectsWithAdvertisedNames = new Set<string>();
  const sessions: WorkspaceSession[] = [];
  const refs = [...snapshot.projection.sessionIndex.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  for (const ref of refs) {
    const hostId = String(ref.hostId);
    const sessionId = String(ref.sessionId);
    const projectId = `${encodeURIComponent(hostId)}/${encodeURIComponent(String(ref.project.projectId))}`;
    const advertisedProjectName =
      ref.project.name !== undefined && ref.project.name !== "" ? ref.project.name : null;
    if (!projects.has(projectId)) {
      const name = projectDisplayName(ref.project);
      projects.set(projectId, { id: projectId, name, path: name, hostId });
      if (advertisedProjectName !== null) projectsWithAdvertisedNames.add(projectId);
    } else if (
      advertisedProjectName !== null &&
      !projectsWithAdvertisedNames.has(projectId)
    ) {
      // A just-created session may omit the optional project name while
      // older refs for the same project still advertise it. Refs are sorted
      // newest-first, so upgrade the id fallback with the first real name and
      // keep that newest advertised value stable for the rest of the fold.
      projects.set(projectId, {
        id: projectId,
        name: advertisedProjectName,
        path: advertisedProjectName,
        hostId,
      });
      projectsWithAdvertisedNames.add(projectId);
    }
    const connection = hostConnection(snapshot, hostId);
    const warm = warmSessionProjection(snapshot, hostId, sessionId);
    const offline = connection.state !== "connected";
    const freshness = offline
      ? "offline"
      : warm !== undefined && warm.freshness !== "fresh"
        ? "cached"
        : "live";
    const pendingApprovals = warm?.confirmations.size ?? (ref.pendingApproval === true ? 1 : 0);
    let status: SessionStatus | null = null;
    if (connection.state === "connecting") status = "connecting";
    else if (pendingApprovals > 0) status = "pendingApproval";
    else if (ref.pendingUserInput === true) status = "awaitingInput";
    else if (ref.proposedPlan !== undefined && ref.proposedPlan !== "") status = "planReady";
    else if (ref.status === "active") status = "working";
    sessions.push({
      id: sessionViewId(hostId, sessionId),
      projectId,
      title: ref.title,
      model: ref.model ?? "",
      status,
      freshness,
      pendingApprovals,
      latestTurnCompletedAt: ref.status === "active" ? null : ref.updatedAt,
      createdAt: ref.updatedAt,
      updatedAt: ref.updatedAt,
      lastActivity: "",
    });
  }

  const data: WorkspaceData =
    sessions.length === 0 && hosts.length === 0
      ? EMPTY_WORKSPACE
      : Object.freeze({
          hosts: Object.freeze(hosts),
          projects: Object.freeze([...projects.values()]),
          sessions: Object.freeze(sessions),
        });
  derived.set(snapshot, data);
  return data;
}

/** The most recently updated live session, for first-frame auto-open. */
export function latestSessionViewId(snapshot: DesktopRuntimeSnapshot): string | null {
  let latest: { viewId: string; updatedAt: string } | null = null;
  for (const ref of snapshot.projection.sessionIndex.values()) {
    if (latest === null || ref.updatedAt.localeCompare(latest.updatedAt) > 0) {
      latest = {
        viewId: sessionViewId(String(ref.hostId), String(ref.sessionId)),
        updatedAt: ref.updatedAt,
      };
    }
  }
  return latest?.viewId ?? null;
}
