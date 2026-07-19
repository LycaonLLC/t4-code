import type {
  TranscriptSearchRequest,
  TranscriptSearchResponse,
  TranscriptSearchSource,
} from "./model.ts";

export interface TranscriptSearchRunCallbacks {
  readonly onStart: () => void;
  readonly onSuccess: (response: TranscriptSearchResponse) => void;
  readonly onError: (error: unknown) => void;
}
/**
 * Owns the latest search request. A source that ignores abort still cannot
 * publish an older result after a newer palette handoff has started.
 */
export class LatestTranscriptSearchExecutor {
  private generation = 0;
  private controller: AbortController | null = null;

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  async run(
    source: TranscriptSearchSource,
    request: TranscriptSearchRequest,
    callbacks: TranscriptSearchRunCallbacks,
  ): Promise<void> {
    this.controller?.abort();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    callbacks.onStart();
    try {
      const response = await source.search(request, controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return;
      this.controller = null;
      callbacks.onSuccess(response);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.controller = null;
      callbacks.onError(error);
    }
  }
}
