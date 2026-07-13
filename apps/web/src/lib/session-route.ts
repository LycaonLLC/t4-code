import type { DesktopRuntimeSnapshot } from "@t4-code/client";

import { resolveCurrentHostTargetId } from "./host-target.ts";
import type { SessionListView, WorkspaceData } from "./workspace-data.ts";

export type SessionRouteDecision =
  | { readonly kind: "present" }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "redirect-home" }
  | { readonly kind: "redirect-session"; readonly sessionId: string };

export const SESSION_ROUTE_PENDING_GRACE_MS = 5_000;

export interface SessionRoutePendingGrace {
  readonly update: (pendingKey: string | null) => void;
  readonly dispose: () => void;
}

/**
 * One timeout per transition into a raw pending route. Repeated pending
 * evaluations keep an expired grace stable instead of silently rearming it.
 */
export function createSessionRoutePendingGrace(
  onTimedOut: (timedOut: boolean) => void,
  timeoutMs = SESSION_ROUTE_PENDING_GRACE_MS,
): SessionRoutePendingGrace {
  let activeKey: string | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function publish(nextTimedOut: boolean): void {
    if (timedOut === nextTimedOut) return;
    timedOut = nextTimedOut;
    onTimedOut(timedOut);
  }

  return {
    update(pendingKey) {
      if (pendingKey === activeKey) return;
      clearTimer();
      activeKey = pendingKey;
      publish(false);
      if (pendingKey === null) return;
      timer = setTimeout(() => {
        timer = null;
        if (activeKey === pendingKey) publish(true);
      }, timeoutMs);
    },
    dispose() {
      clearTimer();
      activeKey = null;
    },
  };
}

/** Apply the elapsed grace only to the raw pending state that armed it. */
export function applySessionRoutePendingGrace(
  decision: SessionRouteDecision,
  pendingTimedOut: boolean,
): SessionRouteDecision {
  return decision.kind === "pending" && pendingTimedOut ? { kind: "unavailable" } : decision;
}

function routeHostId(viewId: string): string | null {
  const separator = viewId.indexOf("/");
  if (separator <= 0 || separator !== viewId.lastIndexOf("/") || separator === viewId.length - 1) {
    return null;
  }
  try {
    const hostId = decodeURIComponent(viewId.slice(0, separator));
    const sessionId = decodeURIComponent(viewId.slice(separator + 1));
    return hostId === "" || sessionId === "" ? null : hostId;
  } catch {
    return null;
  }
}

function visibleProjectIds(data: WorkspaceData): ReadonlySet<string> {
  const hostIds = new Set(data.hosts.map((host) => host.id));
  return new Set(
    data.projects.filter((project) => hostIds.has(project.hostId)).map((project) => project.id),
  );
}

/** Newest session that the default/current rail can actually render. */
export function latestVisibleCurrentSessionId(data: WorkspaceData): string | null {
  const projectIds = visibleProjectIds(data);
  let latest: { readonly id: string; readonly updatedAt: string } | null = null;
  for (const session of data.sessions) {
    if (session.archivedAt !== undefined || !projectIds.has(session.projectId)) continue;
    if (
      latest === null ||
      session.updatedAt > latest.updatedAt ||
      (session.updatedAt === latest.updatedAt && session.id < latest.id)
    ) {
      latest = { id: session.id, updatedAt: session.updatedAt };
    }
  }
  return latest?.id ?? null;
}

/** Home-route continuity without browser-direct implicit attachment. */
export function preferredHomeSessionId(options: {
  readonly activeSessionId: string | null;
  readonly browserDirect: boolean;
  readonly data: WorkspaceData;
  readonly liveRuntime: boolean;
  readonly sessionListView: SessionListView;
}): string | null {
  const { activeSessionId, browserDirect, data, liveRuntime, sessionListView } = options;
  // Home is the meaningful empty state for Archived. Do not let desktop's
  // normal current-session resume policy silently change the selected filter.
  if (browserDirect || sessionListView === "archived") return null;
  const projectIds = visibleProjectIds(data);
  if (
    activeSessionId !== null &&
    data.sessions.some(
      (session) =>
        session.id === activeSessionId &&
        session.archivedAt === undefined &&
        projectIds.has(session.projectId),
    )
  ) {
    return activeSessionId;
  }
  return liveRuntime ? latestVisibleCurrentSessionId(data) : null;
}

/**
 * A missing route is stale only after its host has supplied a complete live
 * session inventory. Cached rows, a welcome frame, and truncated inventories
 * are deliberately insufficient proof of absence.
 */
function hasAuthoritativeInventory(
  snapshot: DesktopRuntimeSnapshot,
  routeSessionId: string,
): boolean {
  const hostId = routeHostId(routeSessionId);
  if (hostId === null) return false;
  const targetId = resolveCurrentHostTargetId(snapshot, hostId);
  if (targetId === null || snapshot.connections.get(targetId) !== "connected") return false;
  const metadata = snapshot.projection.sessionIndexMetadata.get(hostId);
  return metadata !== undefined && !metadata.truncated;
}

/** Pure route policy shared by desktop and browser-direct shells. */
export function decideSessionRoute(options: {
  readonly browserDirect: boolean;
  readonly data: WorkspaceData;
  readonly routeSessionId: string;
  readonly snapshot: DesktopRuntimeSnapshot | null;
}): SessionRouteDecision {
  const { browserDirect, data, routeSessionId, snapshot } = options;
  if (routeHostId(routeSessionId) === null) return { kind: "redirect-home" };
  const session = data.sessions.find((entry) => entry.id === routeSessionId);
  const project =
    session === undefined
      ? undefined
      : data.projects.find((entry) => entry.id === session.projectId);
  if (session !== undefined && project !== undefined) {
    return { kind: "present" };
  }
  if (snapshot === null) return { kind: "not-found" };
  if (!hasAuthoritativeInventory(snapshot, routeSessionId)) {
    return { kind: "pending" };
  }
  if (browserDirect) return { kind: "redirect-home" };
  const latest = latestVisibleCurrentSessionId(data);
  return latest === null
    ? { kind: "redirect-home" }
    : { kind: "redirect-session", sessionId: latest };
}
