import type {
  AgentTranscriptFrame,
  DurableEntry,
  DurableEntryFrame,
  GapFrame,
  LiveEventFrame,
  SessionEvent,
  SessionSnapshotFrame,
} from "@t4-code/protocol";
import type { RendererServerEvent } from "@t4-code/protocol/desktop-ipc";

/**
 * Retained transcript policy, independent of the wire-frame limit.
 *
 * The app-wire decoder bounds each individual frame, but a long-running client
 * can receive thousands of individually valid frames. Eight warm sessions at
 * this limit retain at most 64 MiB of serialized durable transcript payload,
 * before normal JavaScript object overhead. Entry count remains high enough to
 * preserve compact, text-heavy histories while byte-heavy tool results age out.
 */
export const MAX_RETAINED_TRANSCRIPT_ENTRIES = 10_000;
export const MAX_RETAINED_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES = 256 * 1024;
export const MAX_RETAINED_AGENT_TRANSCRIPTS = 16;
export const MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES = 512;
export const MAX_RETAINED_AGENT_TRANSCRIPT_BYTES = 1024 * 1024;

/** Transient event history is useful to Activity, but must not become a second transcript. */
export const MAX_RETAINED_SESSION_EVENTS = 512;
export const MAX_RETAINED_SESSION_EVENTS_BYTES = 2 * 1024 * 1024;
export const MAX_RETAINED_SESSION_EVENT_BYTES = 128 * 1024;

/** Bounded state used by the live renderer while a durable entry is still pending. */
export const MAX_RETAINED_LIVE_MESSAGE_BYTES = 256 * 1024;
export const MAX_RETAINED_LIVE_MESSAGES = 8;
export const MAX_RETAINED_TOOL_CALLS = 64;
export const MAX_RETAINED_TOOL_VALUE_BYTES = 128 * 1024;
export const MAX_RETAINED_PROGRESS_LINE_BYTES = 16 * 1024;

const MAX_RETAINED_VALUE_DEPTH = 8;
const MAX_RETAINED_VALUE_ARRAY_ITEMS = 256;
const MAX_RETAINED_VALUE_KEYS = 256;
const MAX_RETAINED_VALUE_STRING_BYTES = 64 * 1024;
const TRUNCATION_MARKER = "\n… retained value truncated …\n";
const SECRET_KEY = /token|secret|password|credential|authorization|cookie|private.?key/i;

/** Exact byte totals for immutable values created by this module. */
const retainedJsonByteCache = new WeakMap<object, number>();
const UTF8_ENCODER = new TextEncoder();

const IMPORTANT_KEY_PRIORITY: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    type: 0,
    images: 1,
    role: 2,
    text: 3,
    reasoning: 4,
    tool: 5,
    title: 6,
    args: 7,
    result: 8,
    details: 9,
    customType: 10,
    customDetails: 11,
    output: 12,
    stdout: 13,
    stderr: 14,
    content: 15,
  }),
);
const IMPORTANT_KEY_COUNT = Math.max(...Object.values(IMPORTANT_KEY_PRIORITY)) + 1;

interface SanitizedNode {
  readonly value: unknown;
  /** Exact UTF-8 byte count of JSON.stringify(value). */
  readonly bytes: number;
}

export interface RetainedDurableEntries {
  readonly entries: readonly DurableEntry[];
  /** Exact serialized bytes for the retained entry array. */
  readonly bytes: number;
  /** True only when complete entries were omitted, not when one field was shortened. */
  readonly truncated: boolean;
}

export interface RetainDurableEntryOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
}

export type RetainedTranscriptFrame =
  | SessionSnapshotFrame
  | DurableEntryFrame
  | LiveEventFrame
  | AgentTranscriptFrame
  | GapFrame;
export type RetainedTranscriptEvent = Extract<
  RendererServerEvent,
  { kind: "snapshot" | "entry" | "event" | "agent.transcript" | "gap" }
>;

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else {
      bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
    }
  }
  return bytes;
}

export function retainedJsonBytes(value: unknown): number {
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (value === null) return 4;
  if (typeof value === "object" || typeof value === "function") {
    const cached = retainedJsonByteCache.get(value);
    if (cached !== undefined) return cached;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return UTF8_ENCODER.encode(serialized).byteLength;
}

function rememberRetainedJsonBytes<T>(value: T, bytes: number): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    retainedJsonByteCache.set(value, bytes);
  }
  return value;
}

/** JSON array elements stringify unsupported values as `null`, not `undefined`. */
function retainedArrayItemBytes(value: unknown): number {
  const bytes = retainedJsonBytes(value);
  return bytes === 0 && JSON.stringify(value) === undefined ? 4 : bytes;
}

function boundedInteger(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return Math.min(fallback, ceiling);
  return Math.min(value, ceiling);
}

/**
 * Keep both the beginning and the newest tail of a large string. The returned
 * value is guaranteed to fit when encoded as a JSON string, including escapes.
 */
export function retainedText(value: string, maxJsonBytes: number): string {
  const budget = Math.max(2, Math.floor(maxJsonBytes));
  const valueBytes = retainedJsonBytes(value);
  if (valueBytes <= budget && valueBytes <= MAX_RETAINED_VALUE_STRING_BYTES + 2) return value;

  const available = Math.max(0, Math.min(value.length, MAX_RETAINED_VALUE_STRING_BYTES));
  let low = 0;
  let high = available;
  let best = "";
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const head = Math.ceil(kept / 2);
    const tail = Math.floor(kept / 2);
    const candidate = `${value.slice(0, head)}${TRUNCATION_MARKER}${tail === 0 ? "" : value.slice(-tail)}`;
    if (retainedJsonBytes(candidate) <= budget) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  if (best !== "") return best;
  return retainedJsonBytes("") <= budget ? "" : "";
}

function orderedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(value);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = IMPORTANT_KEY_PRIORITY[entries[index - 1]![0]] ?? IMPORTANT_KEY_COUNT;
    const current = IMPORTANT_KEY_PRIORITY[entries[index]![0]] ?? IMPORTANT_KEY_COUNT;
    if (previous <= current) continue;
    entries.sort(([left], [right]) => {
      const leftPriority = IMPORTANT_KEY_PRIORITY[left] ?? IMPORTANT_KEY_COUNT;
      const rightPriority = IMPORTANT_KEY_PRIORITY[right] ?? IMPORTANT_KEY_COUNT;
      return leftPriority - rightPriority;
    });
    break;
  }
  return entries;
}

function sanitizeNode(
  value: unknown,
  budget: number,
  depth: number,
  ancestors: Set<object>,
  imageBlock = false,
): SanitizedNode | undefined {
  if (budget < 1 || value === undefined) return undefined;
  if (value === null || typeof value === "boolean") {
    const bytes = retainedJsonBytes(value);
    return bytes <= budget ? { value, bytes } : undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const bytes = retainedJsonBytes(value);
    return bytes <= budget ? { value, bytes } : undefined;
  }
  if (typeof value === "string") {
    const text = retainedText(value, Math.min(budget, MAX_RETAINED_VALUE_STRING_BYTES + 2));
    const bytes = retainedJsonBytes(text);
    return bytes <= budget ? { value: text, bytes } : undefined;
  }
  if (typeof value !== "object" || depth >= MAX_RETAINED_VALUE_DEPTH || ancestors.has(value)) {
    return undefined;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    let bytes = 2;
    const output: unknown[] = [];
    for (const item of value.slice(0, MAX_RETAINED_VALUE_ARRAY_ITEMS)) {
      const separator = output.length === 0 ? 0 : 1;
      const child = sanitizeNode(item, budget - bytes - separator, depth + 1, ancestors);
      if (child === undefined) continue;
      output.push(child.value);
      bytes += separator + child.bytes;
      if (bytes >= budget) break;
    }
    ancestors.delete(value);
    return bytes <= budget ? { value: Object.freeze(output), bytes } : undefined;
  }

  const source = value as Record<string, unknown>;
  const sourceIsImageBlock = source.type === "image";
  let bytes = 2;
  const output: Record<string, unknown> = {};
  let keys = 0;
  for (const [name, item] of orderedEntries(source)) {
    if (keys >= MAX_RETAINED_VALUE_KEYS || SECRET_KEY.test(name)) continue;
    // Never retain a clipped base64 image: it is both memory-heavy and invalid.
    // Complete small inline images survive; durable transcript image references
    // are prioritized separately through the entry-level `images` field.
    if (
      (imageBlock || sourceIsImageBlock) &&
      name === "data" &&
      typeof item === "string" &&
      retainedJsonBytes(item) > MAX_RETAINED_VALUE_STRING_BYTES
    ) {
      continue;
    }
    const keyBytes = retainedJsonBytes(name);
    const separator = keys === 0 ? 0 : 1;
    const fixedBytes = separator + keyBytes + 1;
    const child = sanitizeNode(
      item,
      budget - bytes - fixedBytes,
      depth + 1,
      ancestors,
      sourceIsImageBlock,
    );
    if (child === undefined) continue;
    output[name] = child.value;
    keys += 1;
    bytes += fixedBytes + child.bytes;
    if (bytes >= budget) break;
  }
  ancestors.delete(value);
  return bytes <= budget ? { value: Object.freeze(output), bytes } : undefined;
}

/** Secret-redacted, depth-bounded, exact-byte-bounded retained JSON value. */
export function sanitizeRetainedValue(value: unknown, maxBytes: number): unknown {
  const budget = Math.max(2, Math.floor(maxBytes));
  const sanitized = sanitizeNode(value, budget, 0, new Set());
  return sanitized === undefined
    ? undefined
    : rememberRetainedJsonBytes(sanitized.value, sanitized.bytes);
}

export function sanitizeRetainedRecord(
  value: unknown,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  const sanitized = sanitizeRetainedValue(value, maxBytes);
  return sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

/** Sanitize one durable entry while preserving its tiny image-reference list first. */
export function sanitizeRetainedDurableEntry(
  entry: DurableEntry,
  maxBytes = MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
): DurableEntry {
  const limit = boundedInteger(maxBytes, MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES, MAX_RETAINED_TRANSCRIPT_BYTES);
  const shell: DurableEntry = {
    id: entry.id,
    parentId: entry.parentId,
    hostId: entry.hostId,
    sessionId: entry.sessionId,
    kind: entry.kind,
    timestamp: entry.timestamp,
    data: {},
  };
  const shellBytesWithoutData = retainedJsonBytes(shell) - 2;
  const data = sanitizeRetainedRecord(entry.data, Math.max(2, limit - shellBytesWithoutData));
  const retained = Object.freeze({ ...shell, data: Object.freeze(data) });
  return rememberRetainedJsonBytes(retained, retainedJsonBytes(retained));
}

function retainedEntryOptions(options: RetainDurableEntryOptions): Required<RetainDurableEntryOptions> {
  const maxBytes = boundedInteger(options.maxBytes, MAX_RETAINED_TRANSCRIPT_BYTES, MAX_RETAINED_TRANSCRIPT_BYTES);
  return {
    maxEntries: boundedInteger(options.maxEntries, MAX_RETAINED_TRANSCRIPT_ENTRIES, MAX_RETAINED_TRANSCRIPT_ENTRIES),
    maxBytes,
    maxEntryBytes: boundedInteger(
      options.maxEntryBytes,
      MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
      Math.min(MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES, maxBytes),
    ),
  };
}

function retainSanitizedEntries(
  entries: readonly DurableEntry[],
  uniqueCount: number,
  config: Required<RetainDurableEntryOptions>,
): RetainedDurableEntries {
  const retained: DurableEntry[] = [];
  let bytes = 2;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const entryBytes = retainedJsonBytes(entry);
    const separator = retained.length === 0 ? 0 : 1;
    if (bytes + separator + entryBytes > config.maxBytes) break;
    retained.push(entry);
    bytes += separator + entryBytes;
  }
  retained.reverse();
  return {
    entries: Object.freeze(retained),
    bytes,
    truncated: retained.length < uniqueCount,
  };
}

/** Install a snapshot as the newest contiguous entry suffix fitting both caps. */
export function retainDurableEntries(
  entries: readonly DurableEntry[],
  options: RetainDurableEntryOptions = {},
): RetainedDurableEntries {
  const config = retainedEntryOptions(options);
  const unique = new Map<string, DurableEntry>();
  for (const entry of entries) {
    const id = String(entry.id);
    if (!unique.has(id)) unique.set(id, entry);
  }
  const candidates = [...unique.values()]
    .slice(-config.maxEntries)
    .map((entry) => sanitizeRetainedDurableEntry(entry, config.maxEntryBytes));
  return retainSanitizedEntries(candidates, unique.size, config);
}

/** Append one entry without recreating untouched retained entry objects. */
export function appendRetainedDurableEntry(
  entries: readonly DurableEntry[],
  entry: DurableEntry,
  options: RetainDurableEntryOptions = {},
): RetainedDurableEntries {
  if (entries.some((existing) => String(existing.id) === String(entry.id))) {
    return { entries, bytes: retainedJsonBytes(entries), truncated: false };
  }
  const config = retainedEntryOptions(options);
  const appended = [
    ...(config.maxEntries === 1 ? [] : entries.slice(-(config.maxEntries - 1))),
    sanitizeRetainedDurableEntry(entry, config.maxEntryBytes),
  ];
  return retainSanitizedEntries(appended, entries.length + 1, config);
}

/**
 * Keep the newest contiguous suffix of already-sanitized values under a
 * cumulative JSON-byte budget. Used for transient event history.
 */
export function appendRetainedValue<T>(
  values: readonly T[],
  value: T,
  maxItems: number,
  maxBytes: number,
): readonly T[] {
  const count = boundedInteger(maxItems, MAX_RETAINED_SESSION_EVENTS, MAX_RETAINED_SESSION_EVENTS);
  const budget = boundedInteger(maxBytes, MAX_RETAINED_SESSION_EVENTS_BYTES, MAX_RETAINED_SESSION_EVENTS_BYTES);
  const firstPriorIndex = count === 1 ? values.length : Math.max(0, values.length - (count - 1));
  let bytes = retainedJsonBytes(values);
  let retainedCount = values.length;

  // Remove only the prefix forced out by the count cap. In steady state this
  // is one O(1) subtraction instead of re-stringifying the 512-event window.
  for (let index = 0; index < firstPriorIndex; index += 1) {
    const removedBytes = retainedArrayItemBytes(values[index]);
    bytes = retainedCount === 1 ? 2 : bytes - removedBytes - 1;
    retainedCount -= 1;
  }

  const candidates = values.slice(firstPriorIndex) as T[];
  candidates.push(value);
  bytes += retainedArrayItemBytes(value) + (retainedCount === 0 ? 0 : 1);
  retainedCount += 1;

  let firstRetainedIndex = 0;
  while (bytes > budget && retainedCount > 0) {
    const removedBytes = retainedArrayItemBytes(candidates[firstRetainedIndex]);
    bytes = retainedCount === 1 ? 2 : bytes - removedBytes - 1;
    retainedCount -= 1;
    firstRetainedIndex += 1;
  }

  const retained = Object.freeze(
    firstRetainedIndex === 0 ? candidates : candidates.slice(firstRetainedIndex),
  );
  return rememberRetainedJsonBytes(retained, bytes);
}

/** Frame copy safe to retain or deliver to renderer subscribers. */
export function sanitizeRetainedTranscriptFrame(frame: RetainedTranscriptFrame): RetainedTranscriptFrame {
  if (frame.type === "snapshot") {
    const retained = retainDurableEntries(frame.entries);
    const entries = Object.freeze([...retained.entries]) as unknown as DurableEntry[];
    return Object.freeze({ ...frame, cursor: Object.freeze({ ...frame.cursor }), entries });
  }
  if (frame.type === "entry") {
    return Object.freeze({
      ...frame,
      cursor: Object.freeze({ ...frame.cursor }),
      entry: sanitizeRetainedDurableEntry(frame.entry),
    });
  }
  if (frame.type === "event") {
    const event = sanitizeRetainedRecord(frame.event, MAX_RETAINED_SESSION_EVENT_BYTES) as SessionEvent;
    return Object.freeze({ ...frame, cursor: Object.freeze({ ...frame.cursor }), event: Object.freeze(event) });
  }
  if (frame.type === "agent.transcript") {
    const retained = retainDurableEntries(frame.entries, {
      maxEntries: MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
      maxBytes: MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
      maxEntryBytes: MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
    });
    const entries = Object.freeze([...retained.entries]) as unknown as DurableEntry[];
    return Object.freeze({ ...frame, cursor: Object.freeze({ ...frame.cursor }), entries });
  }
  return Object.freeze({
    ...frame,
    from: Object.freeze({ ...frame.from }),
    to: Object.freeze({ ...frame.to }),
  });
}

/** Version-free event copy safe to retain or deliver to renderer subscribers. */
export function sanitizeRetainedTranscriptEvent(
  event: RetainedTranscriptEvent,
): RetainedTranscriptEvent {
  if (event.kind === "snapshot") {
    const retained = retainDurableEntries(event.payload.entries);
    const entries = Object.freeze([...retained.entries]) as unknown as DurableEntry[];
    return Object.freeze({
      kind: event.kind,
      payload: Object.freeze({
        ...event.payload,
        cursor: Object.freeze({ ...event.payload.cursor }),
        entries,
      }),
    });
  }
  if (event.kind === "entry") {
    return Object.freeze({
      kind: event.kind,
      payload: Object.freeze({
        ...event.payload,
        cursor: Object.freeze({ ...event.payload.cursor }),
        entry: sanitizeRetainedDurableEntry(event.payload.entry),
      }),
    });
  }
  if (event.kind === "event") {
    const value = sanitizeRetainedRecord(
      event.payload.event,
      MAX_RETAINED_SESSION_EVENT_BYTES,
    ) as SessionEvent;
    return Object.freeze({
      kind: event.kind,
      payload: Object.freeze({
        ...event.payload,
        cursor: Object.freeze({ ...event.payload.cursor }),
        event: Object.freeze(value),
      }),
    });
  }
  if (event.kind === "agent.transcript") {
    const retained = retainDurableEntries(event.payload.entries, {
      maxEntries: MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
      maxBytes: MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
      maxEntryBytes: MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
    });
    const entries = Object.freeze([...retained.entries]) as unknown as DurableEntry[];
    return Object.freeze({
      kind: event.kind,
      payload: Object.freeze({
        ...event.payload,
        cursor: Object.freeze({ ...event.payload.cursor }),
        entries,
      }),
    });
  }
  return Object.freeze({
    kind: event.kind,
    payload: Object.freeze({
      ...event.payload,
      from: Object.freeze({ ...event.payload.from }),
      to: Object.freeze({ ...event.payload.to }),
    }),
  });
}
