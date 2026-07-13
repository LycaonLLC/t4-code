// Display shapes for the workspace tree: hosts, projects, and sessions as
// the rail, palette, and session header render them. Both providers build
// this shape — the browser fixture from sample data, the desktop runtime
// from live protocol frames — and nothing below this seam knows which one
// is feeding it. Display data only; never runtime authority.
import type { SessionStatus } from "@t4-code/ui";

/** How current the projection of a session is. */
export type SessionFreshness = "live" | "cached" | "offline";
export type SessionListView = "current" | "archived";

export interface WorkspaceHost {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "remote";
}

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  /** Display location: a project name or basename, never a remote absolute path. */
  readonly path: string;
  readonly hostId: string;
}

export interface WorkspaceSession {
  readonly id: string;
  readonly projectId: string;
  /** Durable session title (survives disconnects and restarts). */
  readonly title: string;
  readonly model: string;
  /** Live status, or null when the session is idle with nothing pending. */
  readonly status: SessionStatus | null;
  readonly freshness: SessionFreshness;
  /** Commands waiting on the user's go-ahead. */
  readonly pendingApprovals: number;
  readonly latestTurnCompletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** One-line summary of where the session left off. */
  readonly lastActivity: string;
  /** Host authority for archive state; absent means current/default. */
  readonly archivedAt?: string;
}

export interface WorkspaceData {
  readonly hosts: readonly WorkspaceHost[];
  readonly projects: readonly WorkspaceProject[];
  readonly sessions: readonly WorkspaceSession[];
}
