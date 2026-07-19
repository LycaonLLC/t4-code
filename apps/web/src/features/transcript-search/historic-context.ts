import type { TranscriptSearchResult } from "./model.ts";

/**
 * The navigation payload for a host-owned, read-only transcript window.
 * A client adapter can consume this without replacing the session's live
 * projection. Returning to live is therefore a separate, explicit action.
 */
export interface HistoricTranscriptContextIntent {
  readonly hostId: string;
  readonly sessionId: string;
  readonly sessionViewId: string;
  readonly entryId: string;
}
export interface HistoricTranscriptNavigator {
  open(intent: HistoricTranscriptContextIntent): Promise<"opened" | "unavailable">;
}

export function historicContextIntent(
  result: TranscriptSearchResult,
): HistoricTranscriptContextIntent {
  return {
    hostId: result.hostId,
    sessionId: result.sessionId,
    sessionViewId: result.sessionViewId,
    entryId: result.entryId,
  };
}
