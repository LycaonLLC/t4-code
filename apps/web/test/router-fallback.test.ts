import {
  applyPublicFrame,
  createProjectionSnapshot,
  type DesktopRuntimeSnapshot,
  type ProjectionFrame,
  type ProjectionSnapshot,
} from "@t4-code/client";
import { hostId } from "@t4-code/protocol";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WorkspaceData, WorkspaceSession } from "../src/lib/workspace-data.ts";
import {
  applySessionRoutePendingGrace,
  createSessionRoutePendingGrace,
  decideSessionRoute,
  latestVisibleCurrentSessionId,
  preferredHomeSessionId,
  SESSION_ROUTE_PENDING_GRACE_MS,
} from "../src/lib/session-route.ts";

const HOST = "host-a";
const PROJECT = `${HOST}/project-a`;

function workspaceSession(
  id: string,
  updatedAt: string,
  archived = false,
  projectId = PROJECT,
): WorkspaceSession {
  return {
    id: `${HOST}/${id}`,
    projectId,
    title: id,
    model: "model",
    status: null,
    freshness: "live",
    pendingApprovals: 0,
    latestTurnCompletedAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
    lastActivity: "",
    ...(archived ? { archivedAt: updatedAt } : {}),
  };
}

function workspace(sessions: readonly WorkspaceSession[]): WorkspaceData {
  return {
    hosts: [{ id: HOST, name: "Host", kind: "local" }],
    projects: [{ id: PROJECT, name: "Project", path: "Project", hostId: HOST }],
    sessions,
  };
}

function inventoryProjection(truncated = false): ProjectionSnapshot {
  return applyPublicFrame(createProjectionSnapshot(), {
    v: "omp-app/1",
    type: "sessions",
    hostId: hostId(HOST),
    cursor: { epoch: "epoch-1", seq: 0 },
    sessions: [],
    totalCount: truncated ? 10 : 0,
    truncated,
  } as ProjectionFrame);
}

function runtime(
  projection: ProjectionSnapshot,
  options: { readonly bound?: boolean; readonly connected?: boolean } = {},
): DesktopRuntimeSnapshot {
  const bound = options.bound ?? true;
  const connected = options.connected ?? true;
  return {
    version: 1,
    platform: "linux",
    desktopVersion: "test",
    startState: "started",
    targets: new Map(),
    connections: new Map([["local", connected ? "connected" : "connecting"]]),
    targetHosts: bound ? new Map([["local", HOST]]) : new Map(),
    hosts: new Map(),
    catalogs: new Map(),
    settings: new Map(),
    projection,
    runtimeErrors: [],
  };
}

describe("session route fallback", () => {
  it("waits for a bound, connected, complete authoritative inventory", () => {
    const data = workspace([]);
    const routeSessionId = `${HOST}/removed`;
    const noInventory = createProjectionSnapshot();

    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId,
        snapshot: runtime(noInventory),
      }),
    ).toEqual({ kind: "pending" });
    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId,
        snapshot: runtime(inventoryProjection(), { bound: false }),
      }),
    ).toEqual({ kind: "pending" });
    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId,
        snapshot: runtime(inventoryProjection(), { connected: false }),
      }),
    ).toEqual({ kind: "pending" });
    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId,
        snapshot: runtime(inventoryProjection(true)),
      }),
    ).toEqual({ kind: "pending" });
    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId,
        snapshot: runtime(inventoryProjection()),
      }),
    ).toEqual({ kind: "redirect-home" });
  });

  it("re-arms a full grace window after a present route temporarily disconnects", () => {
    vi.useFakeTimers();
    try {
      const current = workspaceSession("current", "2026-07-13T02:00:00Z");
      const routeSessionId = current.id;
      let pendingTimedOut = false;
      const grace = createSessionRoutePendingGrace((timedOut) => {
        pendingTimedOut = timedOut;
      });

      const present = decideSessionRoute({
        browserDirect: false,
        data: workspace([current]),
        routeSessionId,
        snapshot: runtime(inventoryProjection()),
      });
      grace.update(present.kind === "pending" ? routeSessionId : null);
      expect(applySessionRoutePendingGrace(present, pendingTimedOut)).toEqual({ kind: "present" });

      // A healthy route can stay open indefinitely without spending the grace
      // reserved for a later reconnect transition.
      vi.advanceTimersByTime(SESSION_ROUTE_PENDING_GRACE_MS * 2);
      expect(pendingTimedOut).toBe(false);

      const disconnected = decideSessionRoute({
        browserDirect: false,
        data: workspace([]),
        routeSessionId,
        snapshot: runtime(inventoryProjection(), { connected: false }),
      });
      grace.update(disconnected.kind === "pending" ? routeSessionId : null);
      vi.advanceTimersByTime(SESSION_ROUTE_PENDING_GRACE_MS - 1);
      expect(applySessionRoutePendingGrace(disconnected, pendingTimedOut)).toEqual({
        kind: "pending",
      });

      const recovered = decideSessionRoute({
        browserDirect: false,
        data: workspace([current]),
        routeSessionId,
        snapshot: runtime(inventoryProjection()),
      });
      grace.update(recovered.kind === "pending" ? routeSessionId : null);
      vi.advanceTimersByTime(1);
      expect(pendingTimedOut).toBe(false);
      expect(applySessionRoutePendingGrace(recovered, pendingTimedOut)).toEqual({
        kind: "present",
      });
      grace.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an expired pending route unavailable until raw route truth changes", () => {
    vi.useFakeTimers();
    try {
      const routeSessionId = `${HOST}/missing`;
      let pendingTimedOut = false;
      const grace = createSessionRoutePendingGrace((timedOut) => {
        pendingTimedOut = timedOut;
      });
      const pending = decideSessionRoute({
        browserDirect: false,
        data: workspace([]),
        routeSessionId,
        snapshot: runtime(inventoryProjection(), { connected: false }),
      });
      grace.update(pending.kind === "pending" ? routeSessionId : null);
      vi.advanceTimersByTime(SESSION_ROUTE_PENDING_GRACE_MS);
      expect(applySessionRoutePendingGrace(pending, pendingTimedOut)).toEqual({
        kind: "unavailable",
      });

      // Re-evaluating the same raw pending state must not clear or restart the
      // elapsed grace timer.
      grace.update(pending.kind === "pending" ? routeSessionId : null);
      vi.advanceTimersByTime(SESSION_ROUTE_PENDING_GRACE_MS);
      expect(applySessionRoutePendingGrace(pending, pendingTimedOut)).toEqual({
        kind: "unavailable",
      });
      grace.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a connected duplicate binding for authoritative host inventory", () => {
    const snapshot = {
      ...runtime(inventoryProjection()),
      connections: new Map([
        ["disconnected", "disconnected" as const],
        ["connected", "connected" as const],
      ]),
      targetHosts: new Map([
        ["disconnected", HOST],
        ["connected", HOST],
      ]),
    };

    expect(
      decideSessionRoute({
        browserDirect: false,
        data: workspace([]),
        routeSessionId: `${HOST}/removed`,
        snapshot,
      }),
    ).toEqual({ kind: "redirect-home" });
  });

  it("redirects a missing desktop route to the newest visible current session", () => {
    const older = workspaceSession("older", "2026-07-13T01:00:00Z");
    const newest = workspaceSession("newest", "2026-07-13T02:00:00Z");
    const archived = workspaceSession("archived", "2026-07-13T03:00:00Z", true);
    const data = workspace([older, archived, newest]);

    expect(latestVisibleCurrentSessionId(data)).toBe(newest.id);
    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId: `${HOST}/removed`,
        snapshot: runtime(inventoryProjection()),
      }),
    ).toEqual({ kind: "redirect-session", sessionId: newest.id });
  });

  it("renders an indexed archived route for the read-only archive screen", () => {
    const archived = workspaceSession("archived", "2026-07-13T03:00:00Z", true);

    expect(
      decideSessionRoute({
        browserDirect: false,
        data: workspace([archived]),
        routeSessionId: archived.id,
        snapshot: runtime(inventoryProjection()),
      }),
    ).toEqual({ kind: "present" });
  });

  it("does not loop through home when only archived sessions remain", () => {
    const archived = workspaceSession("archived", "2026-07-13T03:00:00Z", true);
    const data = workspace([archived]);

    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId: `${HOST}/removed`,
        snapshot: runtime(inventoryProjection()),
      }),
    ).toEqual({ kind: "redirect-home" });
    expect(
      preferredHomeSessionId({
        activeSessionId: archived.id,
        browserDirect: false,
        data,
        liveRuntime: true,
        sessionListView: "current",
      }),
    ).toBeNull();
  });

  it("keeps an empty Archived selection on home instead of resuming Current", () => {
    const current = workspaceSession("current", "2026-07-13T02:00:00Z");

    expect(
      preferredHomeSessionId({
        activeSessionId: current.id,
        browserDirect: false,
        data: workspace([current]),
        liveRuntime: true,
        sessionListView: "archived",
      }),
    ).toBeNull();
  });

  it("sends browser-direct stale routes home and never auto-attaches from home", () => {
    const current = workspaceSession("current", "2026-07-13T02:00:00Z");
    const data = workspace([current]);

    expect(
      decideSessionRoute({
        browserDirect: true,
        data,
        routeSessionId: `${HOST}/removed`,
        snapshot: runtime(inventoryProjection()),
      }),
    ).toEqual({ kind: "redirect-home" });
    expect(
      preferredHomeSessionId({
        activeSessionId: current.id,
        browserDirect: true,
        data,
        liveRuntime: true,
        sessionListView: "current",
      }),
    ).toBeNull();
  });

  it("keeps indexed routes stable and rejects non-live fixture misses without a loop", () => {
    const current = workspaceSession("current", "2026-07-13T02:00:00Z");
    const data = workspace([current]);

    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId: current.id,
        snapshot: runtime(createProjectionSnapshot()),
      }),
    ).toEqual({ kind: "present" });
    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId: `${HOST}/missing`,
        snapshot: null,
      }),
    ).toEqual({ kind: "not-found" });
  });

  it("opens an indexed browser fixture whose local id has no host prefix", () => {
    const data: WorkspaceData = {
      hosts: [{ id: "fixture-host", name: "Fixture", kind: "local" }],
      projects: [
        {
          id: "fixture-project",
          name: "Fixture project",
          path: "Fixture project",
          hostId: "fixture-host",
        },
      ],
      sessions: [
        {
          id: "sess-stream",
          projectId: "fixture-project",
          title: "Fixture session",
          model: "model",
          status: null,
          freshness: "live",
          pendingApprovals: 0,
          latestTurnCompletedAt: "2026-07-13T02:00:00Z",
          createdAt: "2026-07-13T01:00:00Z",
          updatedAt: "2026-07-13T02:00:00Z",
          lastActivity: "",
        },
      ],
    };

    expect(
      decideSessionRoute({
        browserDirect: false,
        data,
        routeSessionId: "sess-stream",
        snapshot: null,
      }),
    ).toEqual({ kind: "present" });
  });

  it("redirects malformed session ids without waiting for host inventory", () => {
    for (const routeSessionId of ["missing-delimiter", "host/extra/slash", "host/%E0%A4%A"]) {
      expect(
        decideSessionRoute({
          browserDirect: false,
          data: workspace([]),
          routeSessionId,
          snapshot: runtime(createProjectionSnapshot()),
        }),
      ).toEqual({ kind: "redirect-home" });
    }
  });
});
