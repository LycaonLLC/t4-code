import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DesktopRuntimeController } from "@t4-code/client";

import {
  DEFAULT_TRANSCRIPT_SEARCH_FILTERS,
  clientTranscriptSearchSource,
  fixtureTranscriptSearchSource,
  getTranscriptSearchMemorySnapshot,
  getTranscriptSearchQuery,
  handoffTranscriptSearchQuery,
  historicContextIntent,
  LatestTranscriptSearchExecutor,
  plainTextHighlightSegments,
  selectTranscriptSearchSource,
  setTranscriptSearchQuery,
  shouldRefreshTranscriptSearchForFilters,
  TRANSCRIPT_SEARCH_ROUTE,
  TranscriptSearchHandoffTracker,
  TranscriptSearchScreen,
  transcriptSearchCanRun,
  transcriptSearchIsPartial,
  type HistoricTranscriptContext,
  type TranscriptSearchResponse,
  type TranscriptSearchResult,
  type TranscriptSearchSource,
} from "../src/features/transcript-search/index.ts";
import { SHELL_FIXTURE } from "../src/fixture/data.ts";

const realToLocaleLowerCase = String.prototype.toLocaleLowerCase;

afterEach(() => {
  String.prototype.toLocaleLowerCase = realToLocaleLowerCase;
});

const result: TranscriptSearchResult = {
  key: "host-a\u0000session-a\u0000entry-a",
  hostId: "host-a",
  hostLabel: "Studio Mac",
  sessionId: "session-a",
  sessionViewId: "host-a/session-a",
  entryId: "entry-a",
  sessionTitle: "Fix reconnect replay",
  projectId: "project-a",
  projectLabel: "t4-code",
  role: "assistant",
  snippet: "The reconnect decision keeps the durable cursor in memory.",
  occurredAt: "2026-07-18T18:00:00.000Z",
  archived: true,
};

const response: TranscriptSearchResponse = {
  results: [result],
  hosts: [
    { hostId: "host-a", hostLabel: "Studio Mac", state: "searched", resultCount: 1 },
    {
      hostId: "host-b",
      hostLabel: "Build host",
      state: "offline",
      message: "This host is offline and could not be searched.",
    },
  ],
};

const callbacks = {
  onQueryChange: () => {},
  onFiltersChange: () => {},
  onSubmit: () => {},
  onOpenResult: () => {},
  onCloseHistoricContext: () => {},
  onOpenLiveTail: () => {},
  onLoadMoreHost: undefined,
  loadingMoreHostId: null,
  loadMoreError: undefined,
};

describe("transcript search model", () => {
  it("requires a useful query and reports partial multi-host results honestly", () => {
    expect(transcriptSearchCanRun("a")).toBe(false);
    expect(transcriptSearchCanRun("cursor")).toBe(true);
    expect(transcriptSearchIsPartial(response)).toBe(true);
  });

  it("matches uppercase ASCII queries under a Turkish locale", () => {
    // Simulate a Turkish/Azeri locale, where ASCII "I" lowercases to dotless "ı".
    String.prototype.toLocaleLowerCase = function (this: string) {
      return this.replace(/I/g, "ı").toLowerCase();
    };
    expect("IMAGE".toLocaleLowerCase()).toBe("ımage");
    expect(plainTextHighlightSegments("The image pipeline stays put.", "IMAGE")).toEqual([
      { text: "The ", highlighted: false },
      { text: "image", highlighted: true },
      { text: " pipeline stays put.", highlighted: false },
    ]);
  });

  it("hands palette queries to the route in memory without putting them in route state", () => {
    const startingVersion = getTranscriptSearchMemorySnapshot().handoffVersion;
    setTranscriptSearchQuery("durable cursor");
    expect(getTranscriptSearchQuery()).toBe("durable cursor");
    expect(getTranscriptSearchMemorySnapshot().handoffVersion).toBe(startingVersion);
    handoffTranscriptSearchQuery("new palette query");
    expect(getTranscriptSearchMemorySnapshot()).toEqual({
      query: "new palette query",
      handoffVersion: startingVersion + 1,
    });
    expect(TRANSCRIPT_SEARCH_ROUTE).toBe("/search");
    expect(TRANSCRIPT_SEARCH_ROUTE).not.toContain("?");
    setTranscriptSearchQuery("");
  });

  it("lets same-route query B replace query A and rejects a stale A completion", async () => {
    handoffTranscriptSearchQuery("query A");
    const queryAVersion = getTranscriptSearchMemorySnapshot().handoffVersion;
    handoffTranscriptSearchQuery("query B");
    expect(getTranscriptSearchMemorySnapshot()).toEqual({
      query: "query B",
      handoffVersion: queryAVersion + 1,
    });
    const tracker = new TranscriptSearchHandoffTracker();
    expect(tracker.take(getTranscriptSearchMemorySnapshot())?.query).toBe("query B");
    expect(tracker.take(getTranscriptSearchMemorySnapshot())).toBeNull();
    const resolvers = new Map<string, (response: TranscriptSearchResponse) => void>();
    const source: TranscriptSearchSource = {
      search: (request) =>
        new Promise((resolve) => {
          resolvers.set(request.query, resolve);
        }),
      context: () => Promise.reject(new Error("not used")),
    };
    const executor = new LatestTranscriptSearchExecutor();
    const completed: string[] = [];
    const callbacks = {
      onStart: () => {},
      onSuccess: (next: TranscriptSearchResponse) => {
        completed.push(next.results[0]?.snippet ?? "empty");
      },
      onError: () => {},
    };
    const responseFor = (snippet: string): TranscriptSearchResponse => ({
      results: [{ ...result, key: snippet, snippet }],
      hosts: [],
    });

    const queryA = executor.run(
      source,
      { query: "query A", filters: DEFAULT_TRANSCRIPT_SEARCH_FILTERS },
      callbacks,
    );
    const queryB = executor.run(
      source,
      { query: "query B", filters: DEFAULT_TRANSCRIPT_SEARCH_FILTERS },
      callbacks,
    );
    resolvers.get("query B")?.(responseFor("query B"));
    await queryB;
    resolvers.get("query A")?.(responseFor("stale query A"));
    await queryA;

    expect(completed).toEqual(["query B"]);
    setTranscriptSearchQuery("");
  });

  it("supersedes an initial search when filters change and keeps an untouched page idle", async () => {
    expect(shouldRefreshTranscriptSearchForFilters("idle", null)).toBe(false);
    expect(shouldRefreshTranscriptSearchForFilters("searching", null)).toBe(true);

    const resolvers = new Map<string, (response: TranscriptSearchResponse) => void>();
    const source: TranscriptSearchSource = {
      search: (request) =>
        new Promise((resolve) => {
          resolvers.set(request.filters.role, resolve);
        }),
      context: () => Promise.reject(new Error("not used")),
    };
    const executor = new LatestTranscriptSearchExecutor();
    const completed: string[] = [];
    const callbacks = {
      onStart: () => {},
      onSuccess: (next: TranscriptSearchResponse) => {
        completed.push(next.results[0]?.snippet ?? "empty");
      },
      onError: () => {},
    };
    const responseFor = (snippet: string): TranscriptSearchResponse => ({
      results: [{ ...result, key: snippet, snippet }],
      hosts: [],
    });

    const initial = executor.run(
      source,
      { query: "decision", filters: DEFAULT_TRANSCRIPT_SEARCH_FILTERS },
      callbacks,
    );
    const filtered = executor.run(
      source,
      {
        query: "decision",
        filters: { ...DEFAULT_TRANSCRIPT_SEARCH_FILTERS, role: "user" },
      },
      callbacks,
    );
    resolvers.get("user")?.(responseFor("filtered user result"));
    await filtered;
    resolvers.get("all")?.(responseFor("stale unfiltered result"));
    await initial;

    expect(completed).toEqual(["filtered user result"]);
  });

  it("uses the client coordinator whenever a controller exists, including browser-direct", () => {
    const browserDirectController = {} as DesktopRuntimeController;
    expect(selectTranscriptSearchSource(null, SHELL_FIXTURE)).toBe(fixtureTranscriptSearchSource);
    expect(selectTranscriptSearchSource(browserDirectController, SHELL_FIXTURE)).not.toBe(
      fixtureTranscriptSearchSource,
    );
  });

  it("maps an offline client-coordinator host without inventing a successful search", async () => {
    const controller = {
      getSnapshot: () => ({
        targetHosts: new Map(),
        hosts: new Map([["host-a", {}]]),
        connections: new Map(),
      }),
      command: () => Promise.reject(new Error("offline hosts must not receive a command")),
    } as unknown as DesktopRuntimeController;
    const source = clientTranscriptSearchSource(controller, {
      hosts: [{ id: "host-a", name: "Studio Mac", kind: "local" }],
      projects: [],
      sessions: [],
    });
    const search = await source.search(
      { query: "cursor", filters: DEFAULT_TRANSCRIPT_SEARCH_FILTERS },
      new AbortController().signal,
    );

    expect(search.results).toEqual([]);
    expect(search.hosts).toEqual([
      {
        hostId: "host-a",
        hostLabel: "Studio Mac",
        state: "offline",
        resultCount: 0,
        message: "This host is offline and could not be searched.",
      },
    ]);
    expect(transcriptSearchIsPartial(search)).toBe(true);
  });

  it("creates an opaque historic-context intent without transcript text or live projection state", () => {
    expect(historicContextIntent(result)).toEqual({
      hostId: "host-a",
      sessionId: "session-a",
      sessionViewId: "host-a/session-a",
      entryId: "entry-a",
    });
    expect(historicContextIntent(result)).not.toHaveProperty("snippet");
    expect(historicContextIntent(result)).not.toHaveProperty("query");
    expect(historicContextIntent(result)).not.toHaveProperty("projection");
  });

  it("splits plain text for highlighting without producing markup strings", () => {
    expect(plainTextHighlightSegments("Keep the durable cursor and cursor id.", "durable cursor")).toEqual([
      { text: "Keep the ", highlighted: false },
      { text: "durable", highlighted: true },
      { text: " ", highlighted: false },
      { text: "cursor", highlighted: true },
      { text: " and ", highlighted: false },
      { text: "cursor", highlighted: true },
      { text: " id.", highlighted: false },
    ]);
    expect(plainTextHighlightSegments("<script>not markup</script>", "markup")).toContainEqual({
      text: "markup",
      highlighted: true,
    });
  });
});

describe("transcript search screen", () => {
  it("renders memory-only search, filters, partial host status, and plain result snippets", () => {
    const markup = renderToStaticMarkup(
      <TranscriptSearchScreen
        {...callbacks}
        error={undefined}
        filters={DEFAULT_TRANSCRIPT_SEARCH_FILTERS}
        historicContext={null}
        phase="complete"
        projects={[{ id: "project-a", label: "t4-code" }]}
        query="reconnect decision"
        response={response}
      />,
    );

    expect(markup).toContain("Transcript search");
    expect(markup).toContain("Queries and snippets stay in memory");
    expect(markup).toContain("Current and archived");
    expect(markup).toContain("Build host");
    expect(markup).toContain("Offline");
    expect(markup).toContain("Open older context");
    expect(markup).toContain("<mark");
    expect(markup).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders a read-only historic window with an explicit path back to live output", () => {
    const context: HistoricTranscriptContext = {
      rows: [
        {
          entryId: "entry-a",
          role: "assistant",
          occurredAt: result.occurredAt,
          text: result.snippet,
        },
      ],
      anchorIndex: 0,
      hasBefore: true,
      hasAfter: true,
    };
    const markup = renderToStaticMarkup(
      <TranscriptSearchScreen
        {...callbacks}
        error={undefined}
        filters={DEFAULT_TRANSCRIPT_SEARCH_FILTERS}
        historicContext={{ result, phase: "ready", context }}
        phase="complete"
        projects={[]}
        query="decision"
        response={response}
      />,
    );

    expect(markup).toContain("Viewing older transcript context");
    expect(markup).toContain("read-only window");
    expect(markup).toContain("Back to results");
    expect(markup).toContain("Open live tail");
    expect(markup).toContain("Search match");
  });
});
