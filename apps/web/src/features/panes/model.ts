// Inspector pane view models. These are renderer projections built from
// app-wire frames (AgentFrame, LiveEventFrame, TerminalFrame, FileFrame,
// ReviewFrame) — never a second protocol. The wire stays authoritative; this
// module only names the shapes the five pane families render.
import type { ProjectionFreshness } from "@t4-code/client";
import type { AgentState, DurableEntry } from "@t4-code/protocol";

/**
 * Agent lifecycle as the tree renders it. Wire `AgentState` is an open
 * string union; `displayStateFromWire` folds it into this fixed set so the
 * UI never invents per-string styling.
 */
export type AgentDisplayState =
  | "queued"
  | "running"
  | "waiting"
  | "idle"
  | "parked"
  | "completed"
  | "failed"
  | "aborted";

export const AGENT_DISPLAY_STATES: readonly AgentDisplayState[] = [
  "queued",
  "running",
  "waiting",
  "idle",
  "parked",
  "completed",
  "failed",
  "aborted",
];

/** States that end an agent's life; children left running under one are stale. */
export const TERMINAL_AGENT_STATES: Readonly<Record<AgentDisplayState, boolean>> = {
  queued: false,
  running: false,
  waiting: false,
  idle: false,
  parked: false,
  completed: true,
  failed: true,
  aborted: true,
};

/** Fold an open wire state string into the fixed display set. */
export function displayStateFromWire(state: AgentState): AgentDisplayState {
  if ((AGENT_DISPLAY_STATES as readonly string[]).includes(state)) {
    return state as AgentDisplayState;
  }
  if (state === "started") return "running";
  if (state === "cancelled") return "aborted";
  return "queued";
}

export interface AgentTranscriptEntry {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly at: string;
}

export interface AgentNode {
  readonly id: string;
  /** null for the session's main agent; otherwise the spawning agent. */
  readonly parentId: string | null;
  readonly title: string;
  readonly kind: "main" | "batch" | "agent";
  readonly state: AgentDisplayState;
  /** 0..1 from the wire progress channel; null when the agent reports none. */
  readonly progress: number | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly model: string | null;
  readonly worktree: string | null;
  readonly path: string | null;
  readonly currentTool: string | null;
  /** Context window usage reported by the runtime; null when absent/invalid. */
  readonly contextUsed: number | null;
  readonly contextLimit: number | null;
  /** Stall or failure evidence surfaced verbatim; null when nothing is wrong. */
  readonly evidence: string | null;
  /** Durable child-session entries delivered by the negotiated agent transcript stream. */
  readonly transcriptEntries: readonly DurableEntry[];
  readonly transcriptReceived: boolean;
  readonly transcriptFreshness: ProjectionFreshness;
  readonly transcriptHistoryTruncated: boolean;
  /** Legacy text-only transcript retained for older hosts and fixtures. */
  readonly transcript: readonly AgentTranscriptEntry[];
}

export type ActivityKind = "tool" | "agent" | "job" | "system" | "error" | "shell";

export type ActivityFilter = "all" | "tools" | "agents" | "jobs" | "system" | "errors";

export interface ActivityEntry {
  /** Monotonic per-session sequence; ordering authority for the stream. */
  readonly seq: number;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail: string | null;
  readonly agentId: string | null;
  readonly terminalId: string | null;
  /** The decoded wire event payload, kept verbatim for the inspector. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** True when the event type/version is not one this build understands. */
  readonly unknown: boolean;
  /** Read-only agent shell output chunk, when the event carries one. */
  readonly shellOutput: string | null;
}

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed";
export type ReviewFileKind = "text" | "binary" | "huge" | "missing";
export type ReviewApplyState = "pending" | "applied" | "discarded";

export interface ReviewComment {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly side: "old" | "new";
  readonly text: string;
  readonly at: string;
}

export interface ReviewFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: ReviewFileStatus;
  readonly kind: ReviewFileKind;
  readonly additions: number;
  readonly deletions: number;
  /** Unified diff body (`@@` hunks) for text files; null otherwise. */
  readonly patch: string | null;
  readonly sizeBytes: number | null;
  readonly applyState: ReviewApplyState;
}

export interface FileTreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: "dir" | "file";
}

export type FilePreview =
  | { readonly kind: "code"; readonly path: string; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "image"; readonly path: string; readonly src: string }
  | { readonly kind: "binary"; readonly path: string; readonly sizeBytes: number }
  | { readonly kind: "diagnostic"; readonly path: string; readonly message: string }
  | { readonly kind: "offline"; readonly path: string };

export interface ShellInventoryRow {
  readonly terminalId: string;
  /** Agent-owned shells are evidence, never input surfaces. */
  readonly owner: "agent" | "user";
  readonly ownerLabel: string;
  readonly shell: string;
  readonly cwd: string | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly lastOutputAt: string | null;
}

/** Scope shown at the point of an agent control action; never implied. */
export interface AgentControlScope {
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentTitle: string;
  readonly action: "steer" | "cancel" | "wake";
  /** Steer payload, set by the confirmation dialog before dispatch. */
  readonly message?: string;
}
/**
 * Whether one pane action is currently offered, and — when it is not — the
 * plain-language reason shown on the disabled control. The runtime decides
 * (capabilities, catalog, connection); the UI never guesses.
 */
export interface PaneActionAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
}

/** Per-action availability for the pane surfaces that can mutate state. */
export interface InspectorActionAvailability {
  readonly agentSteer: PaneActionAvailability;
  readonly agentCancel: PaneActionAvailability;
  readonly agentWake: PaneActionAvailability;
  readonly reviewApply: PaneActionAvailability;
  readonly reviewDiscard: PaneActionAvailability;
  readonly fileWrite: PaneActionAvailability;
}

const AVAILABLE: PaneActionAvailability = Object.freeze({ enabled: true, reason: null });

/** Fixture default: every action available (the fixture answers locally). */
export const ALL_ACTIONS_AVAILABLE: InspectorActionAvailability = Object.freeze({
  agentSteer: AVAILABLE,
  agentCancel: AVAILABLE,
  agentWake: AVAILABLE,
  reviewApply: AVAILABLE,
  reviewDiscard: AVAILABLE,
  fileWrite: AVAILABLE,
});
