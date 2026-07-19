import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { desktopRuntime } from "../../platform/desktop-runtime.ts";
import { useShellData } from "../../state/shell-data.ts";
import { fixtureTranscriptSearchSource } from "./fixtures.ts";
import { LatestTranscriptSearchExecutor } from "./execution.ts";
import type { HistoricContextState, TranscriptSearchPhase } from "./TranscriptSearchScreen.tsx";
import { TranscriptSearchScreen } from "./TranscriptSearchScreen.tsx";
import {
  DEFAULT_TRANSCRIPT_SEARCH_FILTERS,
  type TranscriptSearchFilters,
  type TranscriptSearchResponse,
  type TranscriptSearchResult,
  transcriptSearchCanRun,
} from "./model.ts";
import {
  setTranscriptSearchQuery,
  TranscriptSearchHandoffTracker,
  useTranscriptSearchMemory,
} from "./search-memory.ts";
import { clientTranscriptSearchSource } from "./source.ts";
import type { DesktopRuntimeController } from "@t4-code/client";
import type { WorkspaceData } from "../../lib/workspace-data.ts";

/** Browser-direct has a real controller; only the disconnected showcase uses fixtures. */
export function selectTranscriptSearchSource(
  controller: DesktopRuntimeController | null,
  data: WorkspaceData,
) {
  return controller === null
    ? fixtureTranscriptSearchSource
    : clientTranscriptSearchSource(controller, data);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "The host did not return a usable response.";
}

/** Live route adapter: ephemeral UI state in, client-owned host fan-out out. */
export function LiveTranscriptSearch() {
  const navigate = useNavigate();
  const shellData = useShellData();
  const controller = desktopRuntime();
  const searchMemory = useTranscriptSearchMemory();
  const query = searchMemory.query;
  const [filters, setFilters] = useState<TranscriptSearchFilters>(
    DEFAULT_TRANSCRIPT_SEARCH_FILTERS,
  );
  const [phase, setPhase] = useState<TranscriptSearchPhase>("idle");
  const [response, setResponse] = useState<TranscriptSearchResponse | null>(null);
  const [error, setError] = useState<string>();
  const [historicContext, setHistoricContext] = useState<HistoricContextState>(null);
  const [loadingMoreHostId, setLoadingMoreHostId] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const searchExecutor = useRef(new LatestTranscriptSearchExecutor()).current;
  const contextAbort = useRef<AbortController | null>(null);
  const loadMoreAbort = useRef<AbortController | null>(null);
  const disposeTimer = useRef<number | null>(null);
  const handoffTracker = useRef(new TranscriptSearchHandoffTracker()).current;

  const source = useMemo(
    () => selectTranscriptSearchSource(controller, shellData),
    [controller, shellData],
  );
  const projects = useMemo(
    () =>
      [...shellData.projects]
        .map((project) => ({ id: project.id, label: project.name }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [shellData.projects],
  );

  const runSearch = useCallback(
    async (
      nextFilters: TranscriptSearchFilters = filters,
      nextQuery: string = query,
    ) => {
      if (!transcriptSearchCanRun(nextQuery)) return;
      loadMoreAbort.current?.abort();
      await searchExecutor.run(
        source,
        { query: nextQuery.trim(), filters: nextFilters },
        {
          onStart: () => {
            setPhase("searching");
            setError(undefined);
            setLoadingMoreHostId(null);
            setLoadMoreError(undefined);
          },
          onSuccess: (next) => {
            setResponse(next);
            setPhase("complete");
          },
          onError: (caught) => {
            setResponse(null);
            setError(errorMessage(caught));
            setPhase("error");
          },
        },
      );
    },
    [filters, query, searchExecutor, source],
  );

  useLayoutEffect(() => {
    const handoff = handoffTracker.take(searchMemory);
    if (handoff === null) return;
    searchExecutor.cancel();
    contextAbort.current?.abort();
    loadMoreAbort.current?.abort();
    setHistoricContext(null);
    setResponse(null);
    setError(undefined);
    setLoadMoreError(undefined);
    setLoadingMoreHostId(null);
    setPhase("idle");
    if (transcriptSearchCanRun(handoff.query)) {
      void runSearch(filters, handoff.query);
    }
  }, [filters, handoffTracker, runSearch, searchExecutor, searchMemory]);

  useEffect(() => {
    // StrictMode immediately runs setup → cleanup → setup in development.
    // Defer disposal one tick so that probe cannot cancel the palette handoff.
    if (disposeTimer.current !== null) window.clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = window.setTimeout(() => {
        searchExecutor.cancel();
        contextAbort.current?.abort();
        loadMoreAbort.current?.abort();
      }, 0);
    };
  }, [searchExecutor]);

  const changeFilters = (next: TranscriptSearchFilters) => {
    setFilters(next);
    if (response !== null && transcriptSearchCanRun(query)) void runSearch(next);
  };

  const openResult = async (result: TranscriptSearchResult) => {
    contextAbort.current?.abort();
    const abort = new AbortController();
    contextAbort.current = abort;
    setHistoricContext({ result, phase: "loading" });
    try {
      const context = await source.context(result, abort.signal);
      if (!abort.signal.aborted) setHistoricContext({ result, phase: "ready", context });
    } catch (caught) {
      if (!abort.signal.aborted) {
        setHistoricContext({ result, phase: "error", error: errorMessage(caught) });
      }
    }
  };

  return (
    <TranscriptSearchScreen
      error={error}
      filters={filters}
      historicContext={historicContext}
      onCloseHistoricContext={() => {
        contextAbort.current?.abort();
        setHistoricContext(null);
      }}
      onFiltersChange={changeFilters}
      onOpenLiveTail={(result) => {
        contextAbort.current?.abort();
        void navigate({ params: { sessionId: result.sessionViewId }, to: "/sessions/$sessionId" });
      }}
      loadingMoreHostId={loadingMoreHostId}
      loadMoreError={loadMoreError}
      onLoadMoreHost={
        source.loadMore === undefined
          ? undefined
          : (hostId) => {
              loadMoreAbort.current?.abort();
              const abort = new AbortController();
              loadMoreAbort.current = abort;
              setLoadingMoreHostId(hostId);
              setLoadMoreError(undefined);
              void source
                .loadMore?.(hostId, abort.signal)
                .then((next) => {
                  if (!abort.signal.aborted) setResponse(next);
                })
                .catch((caught) => {
                  if (!abort.signal.aborted) setLoadMoreError(errorMessage(caught));
                })
                .finally(() => {
                  if (!abort.signal.aborted) setLoadingMoreHostId(null);
                });
            }
      }
      onOpenResult={(result) => void openResult(result)}
      onQueryChange={(next) => {
        setTranscriptSearchQuery(next);
        if (phase !== "idle") {
          searchExecutor.cancel();
          setResponse(null);
          setPhase("idle");
        }
      }}
      onSubmit={() => void runSearch()}
      phase={phase}
      projects={projects}
      query={query}
      response={response}
    />
  );
}
