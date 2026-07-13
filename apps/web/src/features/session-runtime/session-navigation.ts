import type {
  SessionListView,
  WorkspaceSession,
} from "../../lib/workspace-data.ts";

export type CompletedSessionManagementAction = "archive" | "restore" | "delete";

export interface SessionManagementNavigation {
  readonly view: SessionListView;
  readonly destinationSessionId: string | null;
  readonly navigate: boolean;
}

/**
 * Resolve post-command navigation from the converged authoritative inventory.
 * The acted-on row is the pre-command row, so its archive state records which
 * list a delete came from even after the host has removed it.
 */
export function resolveSessionManagementNavigation(
  action: CompletedSessionManagementAction,
  actedOn: WorkspaceSession,
  sessions: readonly WorkspaceSession[],
  active: boolean,
): SessionManagementNavigation {
  if (action === "restore") {
    return {
      view: "current",
      destinationSessionId: actedOn.id,
      navigate: true,
    };
  }

  const view: SessionListView = actedOn.archivedAt === undefined ? "current" : "archived";
  if (!active) return { view, destinationSessionId: null, navigate: false };

  const destinationSessionId =
    sessions.find(
      (candidate) =>
        candidate.id !== actedOn.id &&
        (view === "archived"
          ? candidate.archivedAt !== undefined
          : candidate.archivedAt === undefined),
    )?.id ?? null;
  return { view, destinationSessionId, navigate: true };
}
