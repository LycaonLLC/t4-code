import type {
  HistoricTranscriptContext,
  TranscriptSearchRequest,
  TranscriptSearchResponse,
  TranscriptSearchResult,
  TranscriptSearchSource,
} from "./model.ts";

const NOW = Date.UTC(2026, 6, 18, 18, 0, 0);

const FIXTURE_RESULTS: readonly TranscriptSearchResult[] = [
  {
    key: "host-local:sess-stream:entry-reconnect-decision",
    hostId: "host-local",
    hostLabel: "This machine",
    sessionId: "sess-stream",
    sessionViewId: "sess-stream",
    entryId: "entry-reconnect-decision",
    sessionTitle: "Trace duplicate stream frames after reconnect",
    projectId: "proj-omp",
    projectLabel: "oh-my-pi",
    role: "assistant",
    snippet:
      "The reconnect decision was to keep the durable cursor and ignore duplicate stream frames already applied to the projection.",
    occurredAt: new Date(NOW - 34 * 60_000).toISOString(),
    archived: false,
  },
  {
    key: "host-local:sess-fixtures:entry-protocol-decision",
    hostId: "host-local",
    hostLabel: "This machine",
    sessionId: "sess-fixtures",
    sessionViewId: "sess-fixtures",
    entryId: "entry-protocol-decision",
    sessionTitle: "Pin protocol fixtures for desktop CI",
    projectId: "proj-t4",
    projectLabel: "t4-code",
    role: "user",
    snippet:
      "Keep both strict and legacy protocol fixtures. The compatibility decision needs an explicit release test.",
    occurredAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    archived: false,
  },
  {
    key: "host-local:sess-settings:entry-storage-boundary",
    hostId: "host-local",
    hostLabel: "This machine",
    sessionId: "sess-settings",
    sessionViewId: "sess-settings",
    entryId: "entry-storage-boundary",
    sessionTitle: "Migrate settings store to schema v3",
    projectId: "proj-omp",
    projectLabel: "oh-my-pi",
    role: "assistant",
    snippet:
      "Search terms and transcript snippets stay in memory only; the settings migration must not persist either value.",
    occurredAt: new Date(NOW - 20 * 60 * 60_000).toISOString(),
    archived: false,
  },
  {
    key: "host-local:sess-notes:entry-release-decision",
    hostId: "host-local",
    hostLabel: "This machine",
    sessionId: "sess-notes",
    sessionViewId: "sess-notes",
    entryId: "entry-release-decision",
    sessionTitle: "Draft release notes for v0.1",
    projectId: "proj-t4",
    projectLabel: "t4-code",
    role: "system",
    snippet:
      "Compaction summary: release notes should separate what shipped from what is still planned and environment-blocked.",
    occurredAt: new Date(NOW - 4 * 24 * 60 * 60_000).toISOString(),
    archived: true,
  },
];

function matchesQuery(result: TranscriptSearchResult, query: string): boolean {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const haystack = `${result.snippet} ${result.sessionTitle} ${result.projectLabel}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export const fixtureTranscriptSearchSource: TranscriptSearchSource = {
  async search(request: TranscriptSearchRequest, signal: AbortSignal): Promise<TranscriptSearchResponse> {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 180);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(new DOMException("Search cancelled", "AbortError"));
        },
        { once: true },
      );
    });
    const results = FIXTURE_RESULTS.filter((result) => {
      if (!matchesQuery(result, request.query)) return false;
      if (request.filters.role !== "all" && result.role !== request.filters.role) return false;
      if (
        request.filters.projectId !== null &&
        result.projectId !== request.filters.projectId
      )
        return false;
      if (request.filters.archived === "current" && result.archived) return false;
      if (request.filters.archived === "archived" && !result.archived) return false;
      return true;
    });
    return {
      results,
      hosts: [
        {
          hostId: "host-local",
          hostLabel: "This machine",
          state: "searched",
          resultCount: results.length,
        },
        {
          hostId: "host-remote",
          hostLabel: "dev-server",
          state: "offline",
          message: "This sample host is offline, so its older sessions were not searched.",
        },
      ],
    };
  },
  async context(result: TranscriptSearchResult, signal: AbortSignal): Promise<HistoricTranscriptContext> {
    if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
    return {
      rows: [
        {
          entryId: `${result.entryId}-before`,
          role: "user",
          occurredAt: new Date(Date.parse(result.occurredAt) - 60_000).toISOString(),
          text: "What decision did we make here, and what constraint should the next change preserve?",
        },
        {
          entryId: result.entryId,
          role: result.role,
          occurredAt: result.occurredAt,
          text: result.snippet,
        },
        {
          entryId: `${result.entryId}-after`,
          role: "assistant",
          occurredAt: new Date(Date.parse(result.occurredAt) + 60_000).toISOString(),
          text: "I recorded that boundary in the implementation plan and the focused test list.",
        },
      ],
      anchorIndex: 1,
      hasBefore: true,
      hasAfter: true,
    };
  },
};
