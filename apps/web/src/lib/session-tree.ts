// Derives the project/session tree the rail and palette render: grouping,
// expansion, aggregated status, unread markers, and the visible-session order
// behind Cmd/Ctrl+1..9.
import { resolveHighestPriorityStatus, type SessionStatus } from "@t4-code/ui";

import { isSessionUnread } from "../state/workspace-store.ts";
import type {
  WorkspaceData,
  WorkspaceHost,
  SessionListView,
  WorkspaceProject,
  WorkspaceSession,
} from "./workspace-data.ts";

export interface SessionRow {
  readonly session: WorkspaceSession;
  readonly unread: boolean;
}

export interface ProjectGroup {
  readonly project: WorkspaceProject;
  readonly host: WorkspaceHost;
  readonly expanded: boolean;
  readonly sessions: readonly SessionRow[];
  /** Highest-priority status among children; the collapsed-group signal. */
  readonly groupStatus: SessionStatus | null;
  readonly unreadCount: number;
  readonly pendingApprovals: number;
}

export function buildProjectGroups(
  data: WorkspaceData,
  projectExpandedById: Readonly<Record<string, boolean>>,
  lastVisitedAtBySessionId: Readonly<Record<string, string>>,
  view: SessionListView = "current",
  dismissedEmptyProjectIds: Readonly<Record<string, true>> = {},
): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const project of data.projects) {
    const host = data.hosts.find((entry) => entry.id === project.hostId);
    if (host === undefined) continue;
    const sessions = data.sessions
      .filter(
        (session) =>
          session.projectId === project.id &&
          (view === "archived"
            ? session.archivedAt !== undefined
            : session.archivedAt === undefined),
      )
      .map((session) => ({
        session,
        unread: isSessionUnread(
          lastVisitedAtBySessionId[session.id],
          session.latestTurnCompletedAt,
        ),
      }));
    // Current is also the project-management view. Keep known projects
    // reachable after their final current session is archived so the user can
    // immediately create another session in that working folder, unless they
    // explicitly removed that empty shortcut. A new current session always
    // makes the project visible again. Archived is session-only and never
    // applies the Current-tab dismissal.
    if (sessions.length === 0 && view === "archived") continue;
    if (
      sessions.length === 0 &&
      view === "current" &&
      host.sessionInventoryTruncated !== true &&
      dismissedEmptyProjectIds[project.id] === true
    ) {
      continue;
    }
    groups.push({
      project,
      host,
      expanded: projectExpandedById[project.id] ?? true,
      sessions,
      groupStatus: resolveHighestPriorityStatus(sessions.map((row) => row.session.status)),
      unreadCount: sessions.filter((row) => row.unread).length,
      pendingApprovals: sessions.reduce((sum, row) => sum + row.session.pendingApprovals, 0),
    });
  }
  return groups;
}

/** Sessions reachable by Cmd/Ctrl+1..9: rail order, expanded projects only. */
export function listVisibleSessionIds(groups: readonly ProjectGroup[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (!group.expanded) continue;
    for (const row of group.sessions) ids.push(row.session.id);
  }
  return ids;
}

/** Compact relative time for rail rows and the session header. */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) return "";
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/**
 * Compact 3-character model monogram for the rail's metadata line. Derives a
 * scannable family glyph (`claude-opus-4-6` → "CLA", `gpt-5.6-codex` → "GPT")
 * so the model differentiator stays visible on touch surfaces where the
 * tooltip that carries the full identifier never fires.
 */
export function modelMonogram(model: string): string {
  const tail = model.slice(model.lastIndexOf("/") + 1).trim();
  const head = (tail.split("-")[0] ?? "").trim();
  const code = head.toUpperCase().slice(0, 3);
  return code.length > 0 ? code : "?";
}
