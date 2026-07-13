// Activity stream logic: classify wire session events into render entries,
// filter/search them, redact secrets from the raw inspector, and export.
// Pure functions — the store applies them, tests drive them directly.
import { isSessionEvent, type SessionEvent } from "@t4-code/protocol";

import { sessionEventSpec } from "../session-runtime/session-event-vocabulary.ts";
import type { ActivityEntry, ActivityFilter, ActivityKind } from "./model.ts";

/** Hard cap on retained entries; the stream is a window, not an archive. */
export const ACTIVITY_RETENTION_LIMIT = 2_000;

const FILTER_KINDS: Readonly<Record<ActivityFilter, readonly ActivityKind[] | null>> = {
  all: null,
  tools: ["tool"],
  agents: ["agent"],
  jobs: ["job"],
  system: ["system", "shell"],
  errors: ["error"],
};

function readString(event: SessionEvent, key: string): string | null {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Project one decoded wire event into a stream entry. Unknown event types
 * degrade honestly: they stay in the stream as "system" entries flagged
 * `unknown`, with the raw payload intact for the inspector.
 */
export function classifySessionEvent(
  event: unknown,
  seq: number,
  fallbackAt: string,
): ActivityEntry {
  if (!isSessionEvent(event)) {
    return {
      seq,
      at: fallbackAt,
      kind: "system",
      title: "Unreadable event",
      detail: "This event did not decode as a session event.",
      agentId: null,
      terminalId: null,
      raw: typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {},
      unknown: true,
      shellOutput: null,
    };
  }
  const configuredKind = sessionEventSpec(event.type)?.activityKind;
  // Runtime notices carry their severity in the payload. Keep warnings/info
  // in System, but make an error notice discoverable under the Errors filter.
  const kind =
    event.type === "notice" && event.level === "error" ? "error" : configuredKind;
  const at = readString(event, "at") ?? fallbackAt;
  const agentId = readString(event, "agentId");
  const terminalId = readString(event, "terminalId");
  if (kind === undefined) {
    return {
      seq,
      at,
      kind: "system",
      title: `Unrecognized event: ${event.type}`,
      detail: "This build does not know this event kind. The raw payload is shown as received.",
      agentId,
      terminalId,
      raw: event,
      unknown: true,
      shellOutput: null,
    };
  }
  return {
    seq,
    at,
    kind,
    title: readString(event, "title") ?? event.type,
    detail: readString(event, "detail"),
    agentId,
    terminalId,
    raw: event,
    unknown: false,
    shellOutput: kind === "shell" ? (readString(event, "data") ?? "") : null,
  };
}

/** Append with the retention cap; order is seq order, oldest dropped first. */
export function appendActivity(
  entries: readonly ActivityEntry[],
  entry: ActivityEntry,
): ActivityEntry[] {
  const next = [...entries, entry];
  return next.length > ACTIVITY_RETENTION_LIMIT
    ? next.slice(next.length - ACTIVITY_RETENTION_LIMIT)
    : next;
}

/**
 * The visible slice: filter chips narrow by kind, the query matches title,
 * detail, and agent/terminal ids case-insensitively. Pausing clips the view
 * at the pause sequence without dropping anything from the log itself.
 */
export function selectVisibleActivity(
  entries: readonly ActivityEntry[],
  filter: ActivityFilter,
  query: string,
  pausedAtSeq: number | null,
): ActivityEntry[] {
  const kinds = FILTER_KINDS[filter];
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (pausedAtSeq !== null && entry.seq > pausedAtSeq) return false;
    if (kinds !== null && !kinds.includes(entry.kind)) return false;
    if (needle.length === 0) return true;
    const haystack =
      `${entry.title} ${entry.detail ?? ""} ${entry.agentId ?? ""} ${entry.terminalId ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

const SECRET_KEY_PATTERN = /token|secret|password|passphrase|credential|authorization|api[-_]?key|cookie|bearer|private[-_]?key/i;

/**
 * Deep-copy a payload with secret-looking values replaced. The inspector
 * never renders raw credential material, whatever the runtime sent.
 */
export function redactPayload(value: unknown, keyHint = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, keyHint));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactPayload(entry, key);
    }
    return result;
  }
  if (typeof value === "string" && SECRET_KEY_PATTERN.test(keyHint)) return "[redacted]";
  return value;
}

/** Serialized export of the visible slice; every payload passes redaction. */
export function exportActivity(entries: readonly ActivityEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      kind: entry.kind,
      title: entry.title,
      ...(entry.detail !== null && { detail: entry.detail }),
      ...(entry.agentId !== null && { agentId: entry.agentId }),
      ...(entry.terminalId !== null && { terminalId: entry.terminalId }),
      event: redactPayload(entry.raw),
    })),
    null,
    2,
  );
}
