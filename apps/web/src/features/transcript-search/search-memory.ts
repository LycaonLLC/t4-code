import { useSyncExternalStore } from "react";

/**
 * Deliberately ephemeral handoff between the command palette and /search.
 * It is neither persisted nor encoded in the URL.
 */
let currentQuery = "";
let handoffVersion = 0;
const listeners = new Set<() => void>();

export interface TranscriptSearchMemorySnapshot {
  readonly query: string;
  /** Changes only when another surface explicitly hands a query to /search. */
  readonly handoffVersion: number;
}

/** Consume each palette handoff once, including across StrictMode effect probes. */
export class TranscriptSearchHandoffTracker {
  private handledVersion: number | null = null;

  take(snapshot: TranscriptSearchMemorySnapshot): TranscriptSearchMemorySnapshot | null {
    if (this.handledVersion === snapshot.handoffVersion) return null;
    this.handledVersion = snapshot.handoffVersion;
    return snapshot;
  }
}

let currentSnapshot: TranscriptSearchMemorySnapshot = Object.freeze({
  query: currentQuery,
  handoffVersion,
});

function publish(): void {
  currentSnapshot = Object.freeze({ query: currentQuery, handoffVersion });
  for (const listener of listeners) listener();
}

/** Update the search field itself without starting a new external handoff. */
export function setTranscriptSearchQuery(query: string): void {
  if (query === currentQuery) return;
  currentQuery = query;
  publish();
}

/** Hand a query from the palette to /search, even when /search is already mounted. */
export function handoffTranscriptSearchQuery(query: string): void {
  currentQuery = query;
  handoffVersion += 1;
  publish();
}
export function getTranscriptSearchQuery(): string {
  return currentQuery;
}

export function getTranscriptSearchMemorySnapshot(): TranscriptSearchMemorySnapshot {
  return currentSnapshot;
}

export function useTranscriptSearchMemory(): TranscriptSearchMemorySnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTranscriptSearchMemorySnapshot,
    getTranscriptSearchMemorySnapshot,
  );
}

export function useTranscriptSearchQuery(): string {
  return useTranscriptSearchMemory().query;
}
