export type TranscriptRole = "user" | "assistant" | "system";

export interface TranscriptSearchFilters {
  readonly archived: "all" | "current" | "archived";
  readonly role: "all" | TranscriptRole;
  readonly projectId: string | null;
}

export interface TranscriptSearchRequest {
  readonly query: string;
  readonly filters: TranscriptSearchFilters;
}

export type TranscriptHostSearchState =
  | "searched"
  | "offline"
  | "unsupported"
  | "indexing"
  | "error";

export interface TranscriptHostSearchStatus {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly state: TranscriptHostSearchState;
  readonly resultCount?: number;
  readonly hasMore?: boolean;
  readonly message?: string;
}

/**
 * Search results carry only opaque ids and display-safe text. The renderer
 * never needs a remote path, full transcript, or search query in a URL.
 */
export interface TranscriptSearchResult {
  readonly key: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly sessionId: string;
  readonly sessionViewId: string;
  readonly entryId: string;
  readonly sessionTitle: string;
  readonly projectId: string;
  readonly projectLabel: string;
  readonly role: TranscriptRole;
  readonly snippet: string;
  readonly occurredAt: string;
  readonly archived: boolean;
}

export interface TranscriptSearchResponse {
  readonly results: readonly TranscriptSearchResult[];
  readonly hosts: readonly TranscriptHostSearchStatus[];
  readonly truncated?: boolean;
}

export interface HistoricTranscriptRow {
  readonly entryId: string;
  readonly role: TranscriptRole;
  readonly occurredAt: string;
  readonly text: string;
}

export interface HistoricTranscriptContext {
  readonly rows: readonly HistoricTranscriptRow[];
  readonly anchorIndex: number;
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
}

/** Narrow seam between the web UI and the client-owned search coordinator. */
export interface TranscriptSearchSource {
  search(request: TranscriptSearchRequest, signal: AbortSignal): Promise<TranscriptSearchResponse>;
  context(
    result: TranscriptSearchResult,
    signal: AbortSignal,
  ): Promise<HistoricTranscriptContext>;
  loadMore?(
    hostId: string,
    signal: AbortSignal,
  ): Promise<TranscriptSearchResponse>;
}

export const DEFAULT_TRANSCRIPT_SEARCH_FILTERS: TranscriptSearchFilters = Object.freeze({
  archived: "all",
  role: "all",
  projectId: null,
});

export function transcriptSearchCanRun(query: string): boolean {
  return query.trim().length >= 2;
}

export function transcriptSearchIsPartial(response: TranscriptSearchResponse): boolean {
  return response.truncated === true || response.hosts.some((host) => host.state !== "searched");
}

export interface PlainTextSegment {
  readonly text: string;
  readonly highlighted: boolean;
}

/** Split untrusted plain text into safe React-ready highlight segments. */
export function plainTextHighlightSegments(text: string, query: string): readonly PlainTextSegment[] {
  const terms = [...new Set(query.trim().split(/\s+/u).map((term) => term.toLocaleLowerCase()))]
    .filter((term) => term.length >= 2)
    .sort((left, right) => right.length - left.length);
  if (terms.length === 0) return [{ text, highlighted: false }];
  const lower = text.toLocaleLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const start = lower.indexOf(term, from);
      if (start < 0) break;
      ranges.push({ start, end: start + term.length });
      from = start + term.length;
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  if (merged.length === 0) return [{ text, highlighted: false }];
  const segments: PlainTextSegment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), highlighted: false });
    segments.push({ text: text.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments;
}
