// Timeline row derivation: fold a TranscriptProjection into the flat list the
// virtualized timeline renders. Row objects are structurally shared between
// derivations (same content → same reference) so LegendList and React.memo
// skip untouched rows; structural-sharing approach adapted from T3 Code
// apps/web/src/components/chat/MessagesTimeline.tsx `useStableRows` (MIT,
// T3 Tools Inc., commit f61fa9499d96fee825492aba204593c37b27e0cb).
//
// Rows carry no clock values. Anything that displays elapsed time reads its
// own start timestamp and self-ticks in the DOM, so a running timer never
// re-derives (or re-renders) the list. `formatElapsed` is the pure formatter
// those labels share: first paint is a function of (fromIso, nowMs).
import {
  collaborationMessageFromEntry,
  type CollaborationMessage,
} from "./collaboration-messages.ts";
import { transcriptImagesFromEntry, type TranscriptImageReference } from "./image-metadata.ts";
import {
  type ApprovalRequest,
  type AskRequest,
  type DurableEntry,
  type LiveMessage,
  type PendingPrompt,
  plainRecord,
  type PlanProposal,
  type ToolCall,
  type TranscriptNotice,
  type TranscriptProjection,
} from "./projection.ts";

/** Pure elapsed formatter: "42s" under a minute, then "3m 7s". */
export function formatElapsed(fromIso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export type TranscriptRow =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly reasoning: string;
      readonly images: readonly TranscriptImageReference[];
      readonly imageIssue: string | null;
      /** Live rows stream in place; settled rows come from durable entries. */
      readonly live: boolean;
      readonly startedAt: string;
    }
  | {
      readonly id: string;
      readonly kind: "tool-group";
      readonly calls: readonly TranscriptToolCall[];
      /** True while any call in the group is still running. */
      readonly running: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "collaboration";
      readonly message: CollaborationMessage;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly kind: "notice";
      readonly notice: TranscriptNotice;
    }
  | {
      readonly id: string;
      readonly kind: "unknown-entry";
      readonly entryKind: string;
      readonly data: Record<string, unknown>;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly kind: "working";
      /** Null until a sequenced transcript event supplies a real start time. */
      readonly startedAt: string | null;
      readonly activity: "working" | "preparing-context";
    };

export interface TranscriptToolCall extends ToolCall {
  readonly images: readonly TranscriptImageReference[];
  readonly imageIssue: string | null;
}

export interface AttentionState {
  readonly approval: ApprovalRequest | null;
  readonly ask: AskRequest | null;
  readonly plan: PlanProposal | null;
  readonly error: Extract<TranscriptNotice, { kind: "error" }> | null;
}

/** Read-only transcript views never expose interactive attention controls. */
export function shouldShowAttention(
  attention: AttentionState,
  revisingPlanId: string | null,
  readOnly: boolean,
): boolean {
  return (
    !readOnly &&
    (attention.approval !== null ||
      attention.ask !== null ||
      (attention.plan !== null && revisingPlanId === null) ||
      attention.error !== null)
  );
}

function textOf(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

/** Durable tool entries fold into synthetic settled ToolCalls. */
function toolCallFromEntry(entry: DurableEntry): TranscriptToolCall {
  const data = entry.data;
  const transcriptImages = transcriptImagesFromEntry(entry);
  return {
    callId: entry.id,
    tool: textOf(data, "tool") || "tool",
    title: textOf(data, "title") || textOf(data, "tool") || "tool",
    args: plainRecord(data.args),
    state: data.ok === false ? "error" : "ok",
    startedAt: entry.timestamp,
    progress: [],
    result: data.result === undefined || data.result === null ? null : plainRecord(data.result),
    endedAt: entry.timestamp,
    images: transcriptImages.images,
    imageIssue: transcriptImages.issue,
  };
}

function rowsFromEntries(entries: readonly DurableEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let pendingTools: TranscriptToolCall[] = [];
  let pendingToolGroupId = "";

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    rows.push({
      id: `tools-${pendingToolGroupId}`,
      kind: "tool-group",
      calls: pendingTools,
      running: false,
    });
    pendingTools = [];
    pendingToolGroupId = "";
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case "message": {
        flushTools();
        const collaboration = collaborationMessageFromEntry(entry);
        if (collaboration !== null) {
          rows.push({
            id: entry.id,
            kind: "collaboration",
            message: collaboration,
            timestamp: entry.timestamp,
          });
          break;
        }
        const role = textOf(entry.data, "role") === "user" ? "user" : "assistant";
        const transcriptImages = transcriptImagesFromEntry(entry);
        rows.push({
          id: entry.id,
          kind: "message",
          role,
          text: textOf(entry.data, "text"),
          reasoning: textOf(entry.data, "reasoning"),
          images: transcriptImages.images,
          imageIssue: transcriptImages.issue,
          live: false,
          startedAt: entry.timestamp,
        });
        break;
      }
      case "tool-use":
      case "tool-result": {
        if (pendingTools.length === 0) pendingToolGroupId = entry.id;
        pendingTools.push(toolCallFromEntry(entry));
        break;
      }
      case "compaction": {
        flushTools();
        rows.push({
          id: entry.id,
          kind: "notice",
          notice: {
            kind: "compaction",
            id: entry.id,
            summary: textOf(entry.data, "summary") || "Older context was compacted.",
            droppedEntries:
              typeof entry.data.droppedEntries === "number" ? entry.data.droppedEntries : 0,
            at: entry.timestamp,
          },
        });
        break;
      }
      case "error": {
        flushTools();
        rows.push({
          id: entry.id,
          kind: "notice",
          notice: {
            kind: "error",
            id: entry.id,
            message: textOf(entry.data, "message") || "The turn stopped with an error.",
            retryable: entry.data.retryable === true,
            at: entry.timestamp,
          },
        });
        break;
      }
      default: {
        flushTools();
        rows.push({
          id: entry.id,
          kind: "unknown-entry",
          entryKind: entry.kind,
          data: entry.data,
          timestamp: entry.timestamp,
        });
      }
    }
  }
  flushTools();
  return rows;
}

/**
 * Derive the renderable rows for a projection: settled entries first, then
 * the running turn's live tool group and streaming messages, then transient
 * stream notices, then the working indicator.
 */
export interface TranscriptRowsOptions {
  /** Effective activity may also come from the authoritative session ref. */
  readonly sessionActive?: boolean;
  /** Accepted prompt fallbacks carried by SessionRef.liveState across attach. */
  readonly pendingPrompts?: readonly PendingPrompt[];
}

function acceptedPromptText(text: string, attachmentCount: number): string {
  if (text !== "" || attachmentCount === 0) return text;
  return attachmentCount === 1 ? "Image attached" : `${attachmentCount} images attached`;
}

function liveMessageRow(message: LiveMessage): TranscriptRow {
  return {
    id: message.entryId,
    kind: "message",
    role: message.role,
    text:
      message.role === "user"
        ? acceptedPromptText(message.text, message.attachmentCount)
        : message.text,
    reasoning: message.reasoning,
    images: [],
    imageIssue: null,
    live: true,
    startedAt: message.startedAt,
  };
}

export function deriveTranscriptRows(
  projection: TranscriptProjection,
  options: TranscriptRowsOptions = {},
): TranscriptRow[] {
  const rows = rowsFromEntries(projection.entries);

  if (projection.historyTruncated) {
    rows.unshift({
      id: "notice-history-truncated",
      kind: "notice",
      notice: {
        kind: "history-truncated",
        id: "history-truncated",
        message:
          "Earlier transcript entries are not shown. This app retained the newest history to stay within its memory limit.",
      },
    });
  }

  if (projection.toolCalls.size > 0) {
    const calls: TranscriptToolCall[] = [...projection.toolCalls.values()].map((call) => ({
      ...call,
      images: [],
      imageIssue: null,
    }));
    rows.push({
      id: "live-tools",
      kind: "tool-group",
      calls,
      running: calls.some((call) => call.state === "running"),
    });
  }

  // SessionRef owns accepted-prompt ordering across reconnects. Build that
  // ordered block with exact live-row substitutions, then merge it into the
  // existing live stream by sequenced timestamps. Unrelated assistant/live
  // rows retain their order and an accepted follow-up does not jump above
  // assistant output that was already visible before it was accepted.
  const durableMessageIds = new Set(projection.entries.map((entry) => String(entry.id)));
  const pendingMessageRows: {
    readonly prompt: PendingPrompt;
    readonly row: TranscriptRow;
  }[] = [];
  const pendingIndexById = new Map<string, number>();
  for (const pendingPrompt of options.pendingPrompts ?? []) {
    if (
      durableMessageIds.has(pendingPrompt.entryId) ||
      pendingIndexById.has(pendingPrompt.entryId)
    ) {
      continue;
    }
    const liveMessage = projection.liveMessages.get(pendingPrompt.entryId);
    pendingIndexById.set(pendingPrompt.entryId, pendingMessageRows.length);
    pendingMessageRows.push({
      prompt: pendingPrompt,
      row:
        liveMessage !== undefined
          ? liveMessageRow(liveMessage)
          : {
              id: pendingPrompt.entryId,
              kind: "message",
              role: "user",
              text: acceptedPromptText(pendingPrompt.text, pendingPrompt.attachmentCount),
              reasoning: "",
              images: [],
              imageIssue: null,
              live: true,
              startedAt: pendingPrompt.at,
            },
    });
  }

  let pendingCursor = 0;
  const emitPendingThrough = (lastIndex: number) => {
    while (pendingCursor <= lastIndex) {
      const pending = pendingMessageRows[pendingCursor];
      if (pending === undefined) break;
      rows.push(pending.row);
      pendingCursor += 1;
    }
  };
  for (const message of projection.liveMessages.values()) {
    if (durableMessageIds.has(message.entryId)) continue;
    const matchingPendingIndex = pendingIndexById.get(message.entryId);
    const liveStartedMs = Date.parse(message.startedAt);
    let pendingThrough = pendingCursor - 1;
    if (Number.isFinite(liveStartedMs)) {
      while (pendingThrough + 1 < pendingMessageRows.length) {
        const nextPending = pendingMessageRows[pendingThrough + 1];
        if (nextPending === undefined || Date.parse(nextPending.prompt.at) >= liveStartedMs) {
          break;
        }
        pendingThrough += 1;
      }
    }
    if (matchingPendingIndex !== undefined) {
      pendingThrough = Math.max(pendingThrough, matchingPendingIndex);
    }
    emitPendingThrough(pendingThrough);
    if (matchingPendingIndex !== undefined) continue;
    rows.push(liveMessageRow(message));
  }
  emitPendingThrough(pendingMessageRows.length - 1);

  // Recovery health has one owner: SessionMain's top catch-up banner. A gap
  // row here would repeat the same warning inside role=log and leave the
  // interruption looking like durable transcript history.
  for (const notice of projection.notices) {
    // Errors surface in the attention stack above the composer, not inline;
    // gaps surface in the transient recovery banner; other notices read as
    // inline stream provenance.
    if (notice.kind === "error" || notice.kind === "gap") continue;
    rows.push({ id: `notice-${notice.id}`, kind: "notice", notice });
  }

  const sessionActive =
    options.sessionActive ?? (projection.turnActive || projection.contextMaintenance !== null);
  const assistantStreaming = [...projection.liveMessages.values()].some(
    (message) => message.role === "assistant",
  );
  if (sessionActive && !assistantStreaming) {
    rows.push({
      id: "working",
      kind: "working",
      startedAt:
        projection.contextMaintenance?.startedAt ??
        projection.turnStartedAt ??
        [...projection.liveMessages.values()].at(-1)?.startedAt ??
        null,
      activity: projection.contextMaintenance === null ? "working" : "preparing-context",
    });
  }

  return rows;
}

/** What must interrupt the user right now, stacked above the composer. */
export function deriveAttention(projection: TranscriptProjection): AttentionState {
  let error: Extract<TranscriptNotice, { kind: "error" }> | null = null;
  for (let i = projection.notices.length - 1; i >= 0; i -= 1) {
    const notice = projection.notices[i];
    if (notice !== undefined && notice.kind === "error") {
      error = notice;
      break;
    }
    // A retry after an error supersedes the error banner.
    if (notice !== undefined && notice.kind === "retry") break;
  }
  return {
    approval: projection.approval,
    ask: projection.ask,
    plan: projection.plan,
    error: projection.turnActive ? null : error,
  };
}

// ---------------------------------------------------------------------------
// Structural sharing
// ---------------------------------------------------------------------------

export interface StableRowsState {
  readonly byId: Map<string, TranscriptRow>;
  readonly result: TranscriptRow[];
}

function imageReferencesEqual(
  left: readonly TranscriptImageReference[],
  right: readonly TranscriptImageReference[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined ||
      b === undefined ||
      a.entryId !== b.entryId ||
      a.sha256 !== b.sha256 ||
      a.mimeType !== b.mimeType
    ) {
      return false;
    }
  }
  return true;
}

function toolCallsEqual(a: TranscriptToolCall, b: TranscriptToolCall): boolean {
  if (a === b) return true;
  if (
    a.callId !== b.callId ||
    a.tool !== b.tool ||
    a.title !== b.title ||
    a.state !== b.state ||
    a.startedAt !== b.startedAt ||
    a.endedAt !== b.endedAt ||
    a.args !== b.args ||
    a.result !== b.result ||
    a.imageIssue !== b.imageIssue ||
    !imageReferencesEqual(a.images, b.images) ||
    a.progress.length !== b.progress.length
  ) {
    return false;
  }
  for (let i = 0; i < a.progress.length; i += 1) {
    if (a.progress[i] !== b.progress[i]) return false;
  }
  return true;
}

function collaborationMessagesEqual(a: CollaborationMessage, b: CollaborationMessage): boolean {
  if (
    a === b ||
    (a.variant === b.variant &&
      a.customType === b.customType &&
      a.from === b.from &&
      a.to === b.to &&
      a.body === b.body &&
      a.replyTo === b.replyTo &&
      a.status === b.status &&
      a.jobs === b.jobs)
  ) {
    return true;
  }
  if (
    a.variant !== b.variant ||
    a.customType !== b.customType ||
    a.from !== b.from ||
    a.to !== b.to ||
    a.body !== b.body ||
    a.replyTo !== b.replyTo ||
    a.status !== b.status ||
    a.jobs.length !== b.jobs.length
  ) {
    return false;
  }
  for (let index = 0; index < a.jobs.length; index += 1) {
    const left = a.jobs[index];
    const right = b.jobs[index];
    if (
      left === undefined ||
      right === undefined ||
      left.id !== right.id ||
      left.type !== right.type ||
      left.label !== right.label ||
      left.durationMs !== right.durationMs
    ) {
      return false;
    }
  }
  return true;
}

function rowsEqual(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a.id !== b.id) return false;
  switch (a.kind) {
    case "message":
      return (
        b.kind === "message" &&
        a.role === b.role &&
        a.text === b.text &&
        a.reasoning === b.reasoning &&
        a.imageIssue === b.imageIssue &&
        imageReferencesEqual(a.images, b.images) &&
        a.live === b.live &&
        a.startedAt === b.startedAt
      );
    case "tool-group": {
      if (b.kind !== "tool-group") return false;
      if (a.running !== b.running || a.calls.length !== b.calls.length) return false;
      for (let i = 0; i < a.calls.length; i += 1) {
        const left = a.calls[i];
        const right = b.calls[i];
        if (left === undefined || right === undefined || !toolCallsEqual(left, right)) {
          return false;
        }
      }
      return true;
    }
    case "collaboration":
      return (
        b.kind === "collaboration" &&
        a.timestamp === b.timestamp &&
        collaborationMessagesEqual(a.message, b.message)
      );
    case "notice": {
      if (b.kind !== "notice") return false;
      if (a.notice === b.notice) return true;
      // Entry-derived notices are rebuilt each derivation; compare content.
      return JSON.stringify(a.notice) === JSON.stringify(b.notice);
    }
    case "unknown-entry":
      return b.kind === "unknown-entry" && a.entryKind === b.entryKind && a.data === b.data;
    case "working":
      return b.kind === "working" && a.startedAt === b.startedAt && a.activity === b.activity;
  }
}

/**
 * Reuse previous row references whose content is unchanged. If every row is
 * reused and the count matches, the previous array itself is returned, so
 * `===` short-circuits render work entirely.
 */
export function computeStableRows(
  rows: TranscriptRow[],
  previous: StableRowsState,
): StableRowsState {
  const byId = new Map<string, TranscriptRow>();
  let allReused = rows.length === previous.result.length;
  const result = rows.map((row, index) => {
    const prior = previous.byId.get(row.id);
    const stable = prior !== undefined && rowsEqual(prior, row) ? prior : row;
    if (stable !== previous.result[index]) allReused = false;
    byId.set(row.id, stable);
    return stable;
  });
  return allReused ? previous : { byId, result };
}

export function initialStableRowsState(): StableRowsState {
  return { byId: new Map(), result: [] };
}
