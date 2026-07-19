import {
  createTranscriptSearchCoordinator,
  type TranscriptSearchCoordinator as ClientTranscriptSearchCoordinator,
  type TranscriptSearchRole as ClientTranscriptSearchRole,
  type TranscriptSearchSnapshot as ClientTranscriptSearchSnapshot,
} from "@t4-code/client";
import type { DesktopRuntimeController } from "@t4-code/client";

import type { WorkspaceData } from "../../lib/workspace-data.ts";
import { sessionViewId } from "../../platform/live-workspace.ts";
import type {
  HistoricTranscriptContext,
  TranscriptHostSearchStatus,
  TranscriptRole,
  TranscriptSearchRequest,
  TranscriptSearchResponse,
  TranscriptSearchResult,
  TranscriptSearchSource,
} from "./model.ts";

const coordinators = new WeakMap<DesktopRuntimeController, ClientTranscriptSearchCoordinator>();

function coordinatorFor(controller: DesktopRuntimeController): ClientTranscriptSearchCoordinator {
  let coordinator = coordinators.get(controller);
  if (coordinator === undefined) {
    coordinator = createTranscriptSearchCoordinator(controller);
    coordinators.set(controller, coordinator);
  }
  return coordinator;
}

function uiRole(role: ClientTranscriptSearchRole): TranscriptRole {
  return role === "summary" ? "system" : role;
}

function hostMessage(state: string, errorCode?: string): string | undefined {
  if (state === "offline") return "This host is offline and could not be searched.";
  if (state === "unsupported") return "Update this host to a version that supports transcript search.";
  if (state === "building") return "This host is still building its transcript index. Results may be incomplete.";
  if (state === "stale") return "This host returned results from an older index.";
  if (state === "error") return errorCode === undefined ? "This host could not be searched." : `Search failed (${errorCode}).`;
  return undefined;
}

/** Renderer adapter around the client-owned fan-out, validation, and merge coordinator. */
export function clientTranscriptSearchSource(
  controller: DesktopRuntimeController,
  data: WorkspaceData,
): TranscriptSearchSource {
  const coordinator = coordinatorFor(controller);
  const hostLabels = new Map(data.hosts.map((host) => [host.id, host.name]));
  const projectLabels = new Map(data.projects.map((project) => [project.id, project.name]));
  const uiResponse = (snapshot: ClientTranscriptSearchSnapshot): TranscriptSearchResponse => {
    const results: TranscriptSearchResult[] = snapshot.items.map((item) => ({
      key: `${item.hostId}\u0000${item.sessionId}\u0000${item.anchorId}`,
      hostId: String(item.hostId),
      hostLabel: hostLabels.get(String(item.hostId)) ?? String(item.hostId),
      sessionId: String(item.sessionId),
      sessionViewId: sessionViewId(String(item.hostId), String(item.sessionId)),
      entryId: String(item.anchorId),
      sessionTitle: item.sessionTitle || "Untitled session",
      projectId: String(item.projectId),
      projectLabel: projectLabels.get(String(item.projectId)) ?? String(item.projectId),
      role: uiRole(item.role),
      snippet: item.snippet,
      occurredAt: item.timestamp,
      archived: item.archivedAt !== undefined,
    }));
    const hosts: TranscriptHostSearchStatus[] = [...snapshot.hosts.values()].map((host) => {
      const message = hostMessage(host.state, host.errorCode);
      return {
        hostId: String(host.hostId),
        hostLabel: hostLabels.get(String(host.hostId)) ?? String(host.hostId),
        state:
          host.state === "ready" || host.state === "stale"
            ? "searched"
            : host.state === "building"
              ? "indexing"
              : host.state,
        resultCount: results.filter((item) => item.hostId === host.hostId).length,
        ...(host.nextCursor === undefined ? {} : { hasMore: true }),
        ...(message === undefined ? {} : { message }),
      };
    });
    return { results, hosts, truncated: snapshot.incomplete };
  };
  return {
    async search(request: TranscriptSearchRequest, signal: AbortSignal): Promise<TranscriptSearchResponse> {
      const roles: readonly ClientTranscriptSearchRole[] | undefined =
        request.filters.role === "all"
          ? undefined
          : [request.filters.role === "system" ? "summary" : request.filters.role];
      const snapshot = await coordinator.search(
        {
          query: request.query,
          limit: 50,
          archived:
            request.filters.archived === "all"
              ? "include"
              : request.filters.archived === "archived"
                ? "only"
                : "exclude",
          ...(roles === undefined ? {} : { roles }),
          ...(request.filters.projectId === null
            ? {}
            : { projectId: request.filters.projectId as never }),
        },
        { signal },
      );
      return uiResponse(snapshot);
    },
    async loadMore(hostId: string, signal: AbortSignal): Promise<TranscriptSearchResponse> {
      return uiResponse(await coordinator.loadMore(hostId, { signal }));
    },
    async context(result: TranscriptSearchResult, signal: AbortSignal): Promise<HistoricTranscriptContext> {
      if (signal.aborted) throw new DOMException("Context cancelled", "AbortError");
      const context = await coordinator.context(
        result.hostId,
        result.sessionId,
        {
          anchorId: result.entryId as never,
          before: 12,
          after: 12,
        },
        { signal },
      );
      if (signal.aborted) throw new DOMException("Context cancelled", "AbortError");
      return {
        rows: context.rows.map((row) => ({
          entryId: String(row.anchorId),
          role: uiRole(row.role),
          occurredAt: row.timestamp,
          text: row.text,
        })),
        anchorIndex: context.anchorIndex,
        hasBefore: context.hasBefore,
        hasAfter: context.hasAfter,
      };
    },
  };
}
