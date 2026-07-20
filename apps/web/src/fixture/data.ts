// Typed local shell fixture: the sample workspace the shell renders while no
// runtime connection exists. Everything here is display data — the shell
// never treats it as runtime authority, and the titlebar labels the surface
// as sample data whenever this module feeds it.
import type { WorkspaceData } from "../lib/workspace-data.ts";

export interface ShellFixture extends WorkspaceData {
  /** Seed for first-boot visited timestamps so unread state is realistic. */
  readonly seedLastVisitedAt: Readonly<Record<string, string>>;
}

const now = Date.now();

function minutesAgo(minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

export const SHELL_FIXTURE: ShellFixture = {
  hosts: [
    { id: "host-local", runtimeKind: "omp", name: "This machine", kind: "local" },
    { id: "host-remote", runtimeKind: "omp", name: "dev-server", kind: "remote" },
  ],
  projects: [
    { id: "proj-omp", name: "oh-my-pi", path: "~/dev/oh-my-pi", hostId: "host-local" },
    {
      id: "proj-t4",
      name: "t4-code",
      path: "~/dev/t4-code",
      hostId: "host-local",
    },
    {
      id: "proj-notes",
      name: "notes-app",
      path: "~/dev/notes-app",
      hostId: "host-remote",
    },
  ],
  sessions: [
    {
      id: "sess-stream",
      projectId: "proj-omp",
      title: "Trace duplicate stream frames after reconnect",
      model: "fable-5",
      status: "working",
      lifecycle: "active",
      freshness: "live",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(14),
      createdAt: minutesAgo(190),
      updatedAt: minutesAgo(1),
      lastActivity: "Reading packages/client/src/replay.ts",
    },
    {
      id: "sess-settings",
      projectId: "proj-omp",
      title: "Migrate settings store to schema v3",
      model: "fable-5",
      status: "pendingApproval",
      lifecycle: "active",
      freshness: "live",
      pendingApprovals: 2,
      latestTurnCompletedAt: minutesAgo(6),
      createdAt: minutesAgo(340),
      updatedAt: minutesAgo(6),
      lastActivity: "Wants to run: pnpm migrate --apply",
    },
    {
      id: "sess-bundle",
      projectId: "proj-omp",
      title: "Split renderer bundle for faster cold start",
      model: "kimi-k2.7",
      status: "planReady",
      lifecycle: "active",
      freshness: "live",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(25),
      createdAt: minutesAgo(410),
      updatedAt: minutesAgo(25),
      lastActivity: "Proposed a 4-step plan for review",
    },
    {
      id: "sess-fixtures",
      projectId: "proj-t4",
      title: "Pin protocol fixtures for desktop CI",
      model: "fable-5",
      status: "awaitingInput",
      lifecycle: "active",
      freshness: "live",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(9),
      createdAt: minutesAgo(150),
      updatedAt: minutesAgo(9),
      lastActivity: "Asked which scenario set to keep",
    },
    {
      id: "sess-motion",
      projectId: "proj-t4",
      title: "Add reduced-motion audit to gallery",
      model: "gemini-2.5-flash",
      status: "completed",
      freshness: "live",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(31),
      createdAt: minutesAgo(96),
      updatedAt: minutesAgo(31),
      lastActivity: "All 7 gallery checks pass",
    },
    {
      id: "sess-resize",
      projectId: "proj-t4",
      title: "Bisect flaky terminal resize test",
      model: "fable-5",
      status: "error",
      freshness: "live",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(48),
      createdAt: minutesAgo(230),
      updatedAt: minutesAgo(48),
      lastActivity: "Exited during pnpm test: code 137",
    },
    {
      id: "sess-notes",
      projectId: "proj-t4",
      title: "Draft release notes for v0.1",
      model: "kimi-k2.7",
      status: null,
      freshness: "cached",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(1_440),
      createdAt: minutesAgo(2_980),
      updatedAt: minutesAgo(1_440),
      lastActivity: "Last synced yesterday",
    },
    {
      id: "sess-pagination",
      projectId: "proj-notes",
      title: "Fix pagination off-by-one in notes list",
      model: "fable-5",
      status: null,
      freshness: "offline",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(3_120),
      createdAt: minutesAgo(5_700),
      updatedAt: minutesAgo(3_120),
      lastActivity: "Host unreachable since 09:40",
    },
    {
      id: "sess-theme",
      projectId: "proj-notes",
      title: "Add dark mode toggle to settings page",
      model: "kimi-k2.7",
      status: null,
      freshness: "offline",
      pendingApprovals: 0,
      latestTurnCompletedAt: minutesAgo(4_300),
      createdAt: minutesAgo(8_100),
      updatedAt: minutesAgo(4_300),
      lastActivity: "Host unreachable since 09:40",
    },
  ],
  // Every session except sess-motion was visited after its latest turn, so
  // exactly one row boots with an unread marker.
  seedLastVisitedAt: {
    "sess-stream": minutesAgo(2),
    "sess-settings": minutesAgo(5),
    "sess-bundle": minutesAgo(20),
    "sess-fixtures": minutesAgo(8),
    "sess-motion": minutesAgo(90),
    "sess-resize": minutesAgo(40),
    "sess-notes": minutesAgo(1_400),
    "sess-pagination": minutesAgo(3_000),
    "sess-theme": minutesAgo(4_200),
  },
};
