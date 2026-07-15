// Cursor-aware transcript projection. One pure reducer folds app-wire server
// frames (snapshot / entry / event / gap) into the renderer's view of a
// session: durable entries, live streaming buffers, attention requests, and
// stream health. The reducer never invents runtime truth — it only projects
// what frames carry — and it is the single place the "settled durable entry
// beats live event" rule is enforced.
//
// Ordering rules (IMPLEMENTATION_PLAN §Session stream semantics):
// - A snapshot installs entries *through* its cursor; anything at or before
//   that cursor is already represented and later duplicates are dropped.
// - Sequenced frames (entry/event) apply only when strictly contiguous
//   (seq === cursor.seq + 1 in the same epoch). Duplicates (seq <= cursor.seq)
//   are ignored. A skipped sequence or epoch change pauses this stream until
//   a fresh snapshot arrives; nothing is applied out of order.
// - Durable entries additionally dedupe by stable entry id, never by seq.
// - `message.delta` events append chunks while `message.update` carries the
//   full accumulating text and replaces the live buffer. Once the durable
//   entry with the same id lands, the live buffer is dropped — a settled
//   message never renders twice.
import type {
  Cursor,
  DurableEntry,
  GapFrame,
  LiveEventFrame,
  Revision,
  SessionEvent,
  SessionSnapshotFrame,
} from "@t4-code/protocol";
import {
  MAX_RETAINED_LIVE_MESSAGE_BYTES,
  MAX_RETAINED_LIVE_MESSAGES,
  MAX_RETAINED_PROGRESS_LINE_BYTES,
  MAX_RETAINED_TOOL_CALLS,
  MAX_RETAINED_TOOL_VALUE_BYTES,
  MAX_RETAINED_TRANSCRIPT_BYTES,
  MAX_RETAINED_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  appendRetainedDurableEntry,
  retainDurableEntries,
  retainedText,
  sanitizeRetainedRecord,
} from "@t4-code/client";

import {
  sessionEventSpec,
  type SessionEventProjectionKind,
} from "../session-runtime/session-event-vocabulary.ts";

export type { Cursor, DurableEntry } from "@t4-code/protocol";

/** Health of the sequenced session stream feeding this projection. */
export type StreamPhase =
  | "idle" // nothing attached yet
  | "active" // contiguous frames applying normally
  | "paused" // a sequence gap or epoch change stopped applies; snapshot needed
  | "resyncing"; // server announced a gap; snapshot is on the way

/** Live (not yet durable) message being streamed, keyed by a transient id. */
export interface LiveMessage {
  readonly entryId: string;
  readonly role: "assistant" | "user";
  /** Full accumulated text so far (delta appends; update replaces). */
  readonly text: string;
  /** Full accumulated reasoning text, when the model is thinking aloud. */
  readonly reasoning: string;
  readonly startedAt: string;
}

export type ToolCallState = "running" | "ok" | "error";

/** One tool invocation: start → progress* → result, kept causally together. */
export interface ToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly title: string;
  readonly args: Record<string, unknown>;
  readonly state: ToolCallState;
  readonly startedAt: string;
  /** Rolling progress preview lines (latest last, bounded). */
  readonly progress: readonly string[];
  readonly result: Record<string, unknown> | null;
  readonly endedAt: string | null;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly title: string;
  readonly message: string;
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
}

export interface AskOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
}

export interface AskRequest {
  readonly askId: string;
  readonly question: string;
  readonly options: readonly AskOption[];
  readonly multiple: boolean;
  readonly allowText: boolean;
  readonly requestedAt: string;
}

export interface PlanProposal {
  readonly planId: string;
  readonly title: string;
  /** Markdown body of the proposed plan. */
  readonly body: string;
  readonly proposedAt: string;
}

export type TranscriptNotice =
  | {
      readonly kind: "error";
      readonly id: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly at: string;
      /** Local turn generation that produced this transient error. */
      readonly turnGeneration?: number;
    }
  | {
      readonly kind: "retry";
      readonly id: string;
      readonly attempt: number;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly kind: "compaction";
      readonly id: string;
      readonly summary: string;
      readonly droppedEntries: number;
      readonly at: string;
    }
  | {
      readonly kind: "history-truncated";
      readonly id: string;
      readonly message: string;
    }
  | {
      readonly kind: "gap";
      readonly id: string;
      readonly reason: string;
      readonly missing: number;
      readonly at: string;
    }
  | {
      readonly kind: "protocol";
      readonly id: string;
      readonly message: string;
      readonly at: string;
    };

export interface TranscriptProjection {
  readonly cursor: Cursor | null;
  readonly revision: Revision | null;
  /** Durable, settled transcript in arrival order; deduped by entry id. */
  readonly entries: readonly DurableEntry[];
  /** True when older complete entries no longer fit the retained history budget. */
  readonly historyTruncated: boolean;
  /** Live streaming messages by entry id (usually zero or one). */
  readonly liveMessages: ReadonlyMap<string, LiveMessage>;
  /** Tool calls of the running turn, in start order, keyed by call id. */
  readonly toolCalls: ReadonlyMap<string, ToolCall>;
  /** Whether a turn is currently running (turn.start seen, no turn.end). */
  readonly turnActive: boolean;
  /** Monotonic local identity incremented by every accepted turn.start. */
  readonly turnGeneration: number;
  readonly turnStartedAt: string | null;
  readonly approval: ApprovalRequest | null;
  readonly ask: AskRequest | null;
  readonly plan: PlanProposal | null;
  /** Inline notices (error / retry / compaction / gap), newest last. */
  readonly notices: readonly TranscriptNotice[];
  readonly phase: StreamPhase;
}

const MAX_PROGRESS_LINES = 12;
const MAX_NOTICES = 50;

export function initialProjection(): TranscriptProjection {
  return {
    cursor: null,
    revision: null,
    entries: [],
    historyTruncated: false,
    liveMessages: new Map(),
    toolCalls: new Map(),
    turnActive: false,
    turnGeneration: 0,
    turnStartedAt: null,
    approval: null,
    ask: null,
    plan: null,
    notices: [],
    phase: "idle",
  };
}

// ---------------------------------------------------------------------------
// Frame application
export type TranscriptFrame = SessionSnapshotFrame | DurableEntryFrame | LiveEventFrame | GapFrame;

// app-wire exports DurableEntryFrame from its envelope module; mirror the
// import here so callers can hand us the decoded union directly.
import type { DurableEntryFrame } from "@t4-code/protocol";

function pushNotice(
  notices: readonly TranscriptNotice[],
  notice: TranscriptNotice,
): readonly TranscriptNotice[] {
  const next = [...notices, notice];
  return next.length > MAX_NOTICES ? next.slice(next.length - MAX_NOTICES) : next;
}

function withoutRecoveryNotices(notices: readonly TranscriptNotice[]): readonly TranscriptNotice[] {
  return notices.some((notice) => notice.kind === "gap")
    ? notices.filter((notice) => notice.kind !== "gap")
    : notices;
}

function withoutSupersededErrorNotices(
  notices: readonly TranscriptNotice[],
  completedGeneration: number,
): readonly TranscriptNotice[] {
  return notices.some(
    (notice) =>
      notice.kind === "error" &&
      notice.turnGeneration !== undefined &&
      notice.turnGeneration < completedGeneration,
  )
    ? notices.filter(
        (notice) =>
          notice.kind !== "error" ||
          notice.turnGeneration === undefined ||
          notice.turnGeneration >= completedGeneration,
      )
    : notices;
}

/** Contiguity decision for a sequenced frame against the current cursor. */
function classifySequence(
  cursor: Cursor | null,
  frameCursor: Cursor,
): "apply" | "duplicate" | "gap" {
  if (cursor === null) return "apply";
  if (frameCursor.epoch !== cursor.epoch) return "gap";
  if (frameCursor.seq <= cursor.seq) return "duplicate";
  if (frameCursor.seq === cursor.seq + 1) return "apply";
  return "gap";
}

function installSnapshot(
  projection: TranscriptProjection,
  frame: SessionSnapshotFrame,
): TranscriptProjection {
  const epochChanged = projection.cursor !== null && projection.cursor.epoch !== frame.cursor.epoch;
  const retained = retainDurableEntries(frame.entries, {
    maxEntries: MAX_RETAINED_TRANSCRIPT_ENTRIES,
    maxBytes: MAX_RETAINED_TRANSCRIPT_BYTES,
    maxEntryBytes: MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  });
  const seen = new Set(retained.entries.map((entry) => String(entry.id)));
  // Live buffers already settled by the snapshot are dropped; a snapshot is
  // authoritative through its cursor.
  let liveMessages = epochChanged ? new Map<string, LiveMessage>() : projection.liveMessages;
  if (liveMessages.size > 0) {
    const survivors = new Map<string, LiveMessage>();
    for (const [id, message] of liveMessages) {
      if (!seen.has(id)) survivors.set(id, message);
    }
    liveMessages = survivors;
  }
  return {
    ...projection,
    cursor: frame.cursor,
    revision: frame.revision,
    entries: retained.entries,
    historyTruncated: retained.truncated,
    liveMessages,
    ...(epochChanged
      ? {
          toolCalls: new Map<string, ToolCall>(),
          turnActive: false,
          turnStartedAt: null,
          approval: null,
          ask: null,
          plan: null,
        }
      : {}),
    // A snapshot is authoritative through its cursor and completes the
    // current recovery episode. Gap notices are transient stream state, not
    // durable transcript history, so none may remain pinned after catch-up.
    notices: withoutRecoveryNotices(projection.notices),
    phase: "active",
  };
}

/**
 * Settle volatile turn state when the host's session index authoritatively
 * reports that no work is running. Durable entries and current attention
 * requests are preserved; callers may clear an older transient error only
 * when they observed a later turn start before this authoritative settlement.
 */
export function settleTranscriptTurn(
  projection: TranscriptProjection,
  options: { readonly supersedeTransientErrors?: boolean } = {},
): TranscriptProjection {
  const notices = options.supersedeTransientErrors
    ? withoutSupersededErrorNotices(projection.notices, projection.turnGeneration)
    : projection.notices;
  if (
    !projection.turnActive &&
    projection.turnStartedAt === null &&
    projection.liveMessages.size === 0 &&
    projection.toolCalls.size === 0 &&
    notices === projection.notices
  ) {
    return projection;
  }
  return {
    ...projection,
    turnActive: false,
    turnStartedAt: null,
    liveMessages: new Map(),
    toolCalls: new Map(),
    notices,
  };
}

function applyEntry(
  projection: TranscriptProjection,
  frame: DurableEntryFrame,
): TranscriptProjection {
  const entry = frame.entry;
  const already = projection.entries.some((existing) => existing.id === entry.id);
  // Settled entry wins over its live buffer: drop the buffer either way.
  let liveMessages = projection.liveMessages;
  if (liveMessages.has(entry.id)) {
    const next = new Map(liveMessages);
    next.delete(entry.id);
    liveMessages = next;
  }
  const retained = already
    ? { entries: projection.entries, truncated: false }
    : appendRetainedDurableEntry(projection.entries, entry, {
        maxEntries: MAX_RETAINED_TRANSCRIPT_ENTRIES,
        maxBytes: MAX_RETAINED_TRANSCRIPT_BYTES,
        maxEntryBytes: MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
      });
  return {
    ...projection,
    cursor: frame.cursor,
    revision: frame.revision,
    entries: retained.entries,
    historyTruncated: projection.historyTruncated || retained.truncated,
    liveMessages,
  };
}

// ---------------------------------------------------------------------------
// Event interpretation. SessionEvent is an open record on the wire; these
// helpers read the negotiated event vocabulary defensively — a malformed
// field degrades to a safe default, never a crash. Event types are additive
// by app-wire contract: unknown leaves advance the cursor and stay available
// in the raw Activity inspector without blocking later known events.
// ---------------------------------------------------------------------------

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Guarded narrow of an unknown wire field to a plain string-keyed record. */
export function plainRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // Guarded above: a non-null, non-array object is a plain record for our
    // read-only purposes; wire data is string-keyed by construction.
    const record = value as Record<string, unknown>;
    return record;
  }
  return {};
}

function setInsertionBounded<K, V>(
  source: ReadonlyMap<K, V>,
  key: K,
  value: V,
  max: number,
): ReadonlyMap<K, V> {
  const next = new Map(source);
  // Map#set preserves the original insertion position for an existing key.
  // Only a genuinely new item belongs at the tail and can evict the oldest.
  next.set(key, value);
  while (next.size > max) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function boundedEventText(value: unknown, maxBytes: number, fallback = ""): string {
  return retainedText(str(value, fallback), maxBytes);
}

function eventTimestamp(event: SessionEvent): string {
  return retainedText(str(event.at, new Date(0).toISOString()), 256);
}

function applyMessageEvent(
  projection: TranscriptProjection,
  event: SessionEvent,
  mode: "delta" | "update",
): TranscriptProjection {
  const entryId = str(event.entryId);
  if (entryId === "") return projection;
  // A durable entry with this id already settled: the live event is stale.
  if (projection.entries.some((entry) => entry.id === entryId)) return projection;
  const previous = projection.liveMessages.get(entryId);
  const incomingText = str(event.text);
  const incomingReasoning = str(event.reasoning);
  const message: LiveMessage = {
    entryId,
    role:
      event.role === "user"
        ? "user"
        : event.role === "assistant"
          ? "assistant"
          : (previous?.role ?? "assistant"),
    text:
      mode === "delta"
        ? retainedText(
            `${previous?.text ?? ""}${incomingText}`,
            Math.floor((MAX_RETAINED_LIVE_MESSAGE_BYTES * 3) / 4),
          )
        : retainedText(
            str(event.text, previous?.text ?? ""),
            Math.floor((MAX_RETAINED_LIVE_MESSAGE_BYTES * 3) / 4),
          ),
    reasoning:
      mode === "delta"
        ? retainedText(
            `${previous?.reasoning ?? ""}${incomingReasoning}`,
            Math.floor(MAX_RETAINED_LIVE_MESSAGE_BYTES / 4),
          )
        : retainedText(
            str(event.reasoning, previous?.reasoning ?? ""),
            Math.floor(MAX_RETAINED_LIVE_MESSAGE_BYTES / 4),
          ),
    startedAt: previous?.startedAt ?? eventTimestamp(event),
  };
  const next = setInsertionBounded(
    projection.liveMessages,
    entryId,
    message,
    MAX_RETAINED_LIVE_MESSAGES,
  );
  return { ...projection, liveMessages: next };
}

/**
 * Re-key a completed live message using the appserver's authoritative
 * transient-to-durable mapping. OMP mints the durable transcript id only when
 * it persists the message, so matching on text or timestamps is ambiguous.
 */
function applyMessageSettled(
  projection: TranscriptProjection,
  event: SessionEvent,
): TranscriptProjection {
  const transientEntryId = str(event.transientEntryId);
  const entryId = str(event.entryId);
  if (transientEntryId === "" || entryId === "") return projection;

  const live = projection.liveMessages.get(transientEntryId);
  if (live === undefined) return projection;
  const durableAlreadySettled = projection.entries.some((entry) => entry.id === entryId);
  const next = new Map<string, LiveMessage>();
  for (const [id, message] of projection.liveMessages) {
    if (id === transientEntryId) {
      if (!durableAlreadySettled) next.set(entryId, { ...live, entryId });
    } else if (id !== entryId) {
      next.set(id, message);
    }
  }
  return { ...projection, liveMessages: next };
}

function applyToolEvent(
  projection: TranscriptProjection,
  event: SessionEvent,
  kind: "start" | "progress" | "result" | "error",
): TranscriptProjection {
  const callId = str(event.callId);
  if (callId === "") return projection;
  let calls = projection.toolCalls;
  const existing = calls.get(callId);
  if (kind === "start") {
    calls = setInsertionBounded(
      calls,
      callId,
      {
        callId,
        tool: boundedEventText(event.tool, 4 * 1024, "tool"),
        title: boundedEventText(event.title, 8 * 1024, str(event.tool, "tool")),
        args: sanitizeRetainedRecord(event.args, Math.floor(MAX_RETAINED_TOOL_VALUE_BYTES / 4)),
        state: "running",
        startedAt: eventTimestamp(event),
        progress: [],
        result: null,
        endedAt: null,
      },
      MAX_RETAINED_TOOL_CALLS,
    );
  } else if (kind === "progress") {
    if (existing === undefined) return projection;
    const line = boundedEventText(event.note, MAX_RETAINED_PROGRESS_LINE_BYTES, str(event.chunk));
    const progress =
      line === "" ? existing.progress : [...existing.progress, line].slice(-MAX_PROGRESS_LINES);
    calls = setInsertionBounded(calls, callId, { ...existing, progress }, MAX_RETAINED_TOOL_CALLS);
  } else {
    // tool.result
    if (existing === undefined) return projection;
    calls = setInsertionBounded(
      calls,
      callId,
      {
        ...existing,
        state: kind === "error" || event.ok === false ? "error" : "ok",
        result: sanitizeRetainedRecord(
          event.result,
          Math.floor((MAX_RETAINED_TOOL_VALUE_BYTES * 3) / 4),
        ),
        endedAt: eventTimestamp(event),
      },
      MAX_RETAINED_TOOL_CALLS,
    );
  }
  return { ...projection, toolCalls: calls };
}

let noticeCounter = 0;
function noticeId(prefix: string): string {
  noticeCounter += 1;
  return `${prefix}-${noticeCounter}`;
}

function applyEvent(projection: TranscriptProjection, frame: LiveEventFrame): TranscriptProjection {
  const event = frame.event;
  const base: TranscriptProjection = { ...projection, cursor: frame.cursor };
  const projectionKind: SessionEventProjectionKind | undefined = sessionEventSpec(
    event.type,
  )?.projection;
  switch (projectionKind) {
    case "turn-start":
      return {
        ...base,
        turnActive: true,
        turnGeneration: base.turnGeneration + 1,
        turnStartedAt: eventTimestamp(event),
        toolCalls: new Map(),
        approval: null,
        ask: null,
        plan: null,
      };
    case "turn-end":
      return {
        ...base,
        turnActive: false,
        approval: null,
        ask: null,
        liveMessages: new Map(),
        // Appserver may emit turn.error followed by turn.end for one failed
        // turn. Preserve that generation's error; only older turns are done.
        notices: withoutSupersededErrorNotices(base.notices, base.turnGeneration),
      };
    case "agent-end":
      return {
        ...base,
        turnActive: false,
        approval: null,
        ask: null,
        liveMessages: new Map(),
        // Failed/cancelled endings keep their explanation. A completed ending
        // only supersedes errors owned by an earlier turn generation.
        notices:
          event.status === "completed"
            ? withoutSupersededErrorNotices(base.notices, base.turnGeneration)
            : base.notices,
      };
    case "message-delta":
      return applyMessageEvent(base, event, "delta");
    case "message-update":
      return applyMessageEvent(base, event, "update");
    case "message-settled":
      return applyMessageSettled(base, event);
    case "tool-start":
      return applyToolEvent(base, event, "start");
    case "tool-progress":
      return applyToolEvent(base, event, "progress");
    case "tool-result":
      return applyToolEvent(base, event, "result");
    case "tool-error":
      return applyToolEvent(base, event, "error");
    case "approval-request":
      return {
        ...base,
        approval: {
          approvalId: boundedEventText(event.approvalId, 512),
          title: boundedEventText(event.title, 8 * 1024, "Approval needed"),
          message: boundedEventText(event.message, 32 * 1024),
          command: boundedEventText(event.command, 8 * 1024),
          args: sanitizeRetainedRecord(event.args, 32 * 1024),
          requestedAt: eventTimestamp(event),
          expiresAt: typeof event.expiresAt === "string" ? event.expiresAt : null,
        },
      };
    case "approval-resolved":
      return projection.approval !== null &&
        projection.approval.approvalId === str(event.approvalId)
        ? { ...base, approval: null }
        : base;
    case "ask-request": {
      const rawOptions = Array.isArray(event.options) ? event.options.slice(0, 64) : [];
      const options: AskOption[] = rawOptions.map((raw, index) => {
        const option = plainRecord(raw);
        return {
          id: boundedEventText(option.id, 512, `option-${index + 1}`),
          label: boundedEventText(option.label, 4 * 1024, `Option ${index + 1}`),
          detail: typeof option.detail === "string" ? retainedText(option.detail, 8 * 1024) : null,
        };
      });
      return {
        ...base,
        ask: {
          askId: boundedEventText(event.askId, 512),
          question: boundedEventText(event.question, 32 * 1024),
          options,
          multiple: event.multiple === true,
          allowText: event.allowText === true,
          requestedAt: eventTimestamp(event),
        },
      };
    }
    case "ask-resolved":
      return projection.ask !== null && projection.ask.askId === str(event.askId)
        ? { ...base, ask: null }
        : base;
    case "plan-ready":
      return {
        ...base,
        plan: {
          planId: boundedEventText(event.planId, 512),
          title: boundedEventText(event.title, 8 * 1024, "Proposed plan"),
          body: boundedEventText(event.body, MAX_RETAINED_LIVE_MESSAGE_BYTES),
          proposedAt: eventTimestamp(event),
        },
      };
    case "plan-resolved":
      return projection.plan !== null && projection.plan.planId === str(event.planId)
        ? { ...base, plan: null }
        : base;
    case "turn-error":
      return {
        ...base,
        turnActive: false,
        liveMessages: new Map(),
        notices: pushNotice(base.notices, {
          kind: "error",
          id: noticeId("error"),
          message: boundedEventText(
            event.message,
            32 * 1024,
            str(event.detail, str(event.title, "The turn stopped with an error.")),
          ),
          retryable: event.retryable === true,
          at: eventTimestamp(event),
          turnGeneration: base.turnGeneration,
        }),
      };
    case "turn-retry":
      return {
        ...base,
        notices: pushNotice(base.notices, {
          kind: "retry",
          id: noticeId("retry"),
          attempt: typeof event.attempt === "number" ? event.attempt : 1,
          reason: boundedEventText(event.reason, 16 * 1024, str(event.detail, "Transient failure")),
          at: eventTimestamp(event),
        }),
      };
    case "compaction":
      return {
        ...base,
        notices: pushNotice(base.notices, {
          kind: "compaction",
          id: noticeId("compaction"),
          summary: boundedEventText(
            event.summary,
            32 * 1024,
            str(event.detail, "Older context was compacted."),
          ),
          droppedEntries: typeof event.droppedEntries === "number" ? event.droppedEntries : 0,
          at: eventTimestamp(event),
        }),
      };
    case "inspect-only":
    case undefined:
      // SessionEvent leaf types are additive. Activity retains the raw event;
      // the transcript only needs to keep sequence continuity here.
      return base;
  }
}

function applyGap(projection: TranscriptProjection, frame: GapFrame): TranscriptProjection {
  // Multiple gap frames can arrive while the client is already awaiting the
  // same recovery snapshot. Keep one row (and therefore one stable React key)
  // for that episode instead of stacking replay-budget notices at the tail.
  if (
    (projection.phase === "paused" || projection.phase === "resyncing") &&
    projection.notices.some((notice) => notice.kind === "gap")
  ) {
    return projection.phase === "resyncing" ? projection : { ...projection, phase: "resyncing" };
  }
  return {
    ...projection,
    phase: "resyncing",
    notices: pushNotice(withoutRecoveryNotices(projection.notices), {
      kind: "gap",
      id: `gap-${frame.from.epoch}-${frame.from.seq}-${frame.to.epoch}-${frame.to.seq}`,
      reason: frame.reason,
      missing: frame.to.seq - frame.from.seq,
      at: new Date(0).toISOString(),
    }),
  };
}

/**
 * Fold one server frame into the projection. Pure: same inputs, same output;
 * unchanged branches keep their object identity so memoized rows survive.
 */
export function reduceTranscript(
  projection: TranscriptProjection,
  frame: TranscriptFrame,
): TranscriptProjection {
  switch (frame.type) {
    case "snapshot":
      return installSnapshot(projection, frame);
    case "gap":
      return applyGap(projection, frame);
    case "entry":
    case "event": {
      // A paused stream applies nothing until a snapshot arrives — applying
      // past a gap would reorder history.
      if (projection.phase === "paused" || projection.phase === "resyncing") {
        return projection;
      }
      const verdict = classifySequence(projection.cursor, frame.cursor);
      if (verdict === "duplicate") return projection;
      if (verdict === "gap") {
        const from = projection.cursor;
        return {
          ...projection,
          phase: "paused",
          notices: pushNotice(withoutRecoveryNotices(projection.notices), {
            kind: "gap",
            id: `gap-${from?.epoch ?? "initial"}-${from?.seq ?? 0}-${frame.cursor.epoch}-${frame.cursor.seq}`,
            reason: "sequence discontinuity",
            missing:
              from !== null && frame.cursor.epoch === from.epoch
                ? frame.cursor.seq - from.seq - 1
                : 0,
            at: new Date(0).toISOString(),
          }),
        };
      }
      if (frame.type === "entry") return applyEntry(projection, frame);
      return applyEvent(projection, frame);
    }
  }
}
