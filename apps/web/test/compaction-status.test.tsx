import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { TranscriptImageSource } from "../src/features/session-runtime/transcript-images.ts";
import { FrameFactory } from "../src/features/session-runtime/frame-builders.ts";
import {
  initialProjection,
  reduceTranscript,
  type TranscriptProjection,
} from "../src/features/transcript/projection.ts";
import { deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { TranscriptRowContent } from "../src/features/transcript/TranscriptRows.tsx";

const IMAGE_SOURCE: TranscriptImageSource = {
  getSnapshot: () => ({ status: "unavailable", reason: "not used" }),
  subscribe: () => () => undefined,
  retain: () => () => undefined,
  reportDecodeFailure: () => undefined,
  dispose: () => undefined,
};

function renderWorkingRow(
  projection: TranscriptProjection,
  nowMs: number,
  options?: { readonly ghost?: boolean },
): string | null {
  const row = deriveTranscriptRows(projection).find((candidate) => candidate.kind === "working");
  if (row?.kind !== "working") return null;
  return renderToStaticMarkup(
    <TranscriptRowContent
      ghost={options?.ghost ?? false}
      imageSource={IMAGE_SOURCE}
      nowMs={nowMs}
      row={row}
    />,
  );
}

function projectionWithSnapshot(factory: FrameFactory): TranscriptProjection {
  return reduceTranscript(initialProjection(), factory.snapshot([]));
}

describe("compaction transcript status", () => {
  it("renders an elapsed visual compaction status until compaction.end", () => {
    const factory = new FrameFactory({ host: "host", session: "session", epoch: "epoch" });
    let projection = projectionWithSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "compaction.start",
        reason: "pending_prompt_size",
        at: "2026-07-15T20:00:01Z",
      }),
    );

    const markup = renderWorkingRow(projection, Date.parse("2026-07-15T20:00:06Z"));
    expect(markup).not.toBeNull();
    expect(markup).toContain('data-transcript-status="compacting-context"');
    expect(markup).toContain('<span aria-hidden="true">Compacting context for ');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("aria-live");
    expect(markup).toContain("Compacting context for ");
    expect(markup).toContain("5s");
    expect(markup).not.toContain("Preparing context");

    projection = reduceTranscript(
      projection,
      factory.event({ type: "compaction.end", at: "2026-07-15T20:00:07Z" }),
    );
    expect(renderWorkingRow(projection, Date.parse("2026-07-15T20:00:07Z"))).toBeNull();
  });

  it("replaces the compaction label with ordinary working status on a recovery turn.start", () => {
    const factory = new FrameFactory({ host: "host", session: "session", epoch: "epoch" });
    let projection = projectionWithSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "compaction.start",
        reason: "pending_prompt_size",
        at: "2026-07-15T20:00:01Z",
      }),
    );
    expect(renderWorkingRow(projection, Date.parse("2026-07-15T20:00:02Z"))).toContain(
      "Compacting context for ",
    );

    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-15T20:00:03Z" }),
    );
    const markup = renderWorkingRow(projection, Date.parse("2026-07-15T20:00:07Z"));
    expect(markup).not.toBeNull();
    expect(markup).toContain('data-transcript-status="working"');
    expect(markup).toContain("Working for ");
    expect(markup).toContain("4s");
    expect(markup).not.toContain("Compacting context");
  });

  it("keeps the lifecycle hook off paint-only ghost copies so one semantic row exists", () => {
    const factory = new FrameFactory({ host: "host", session: "session", epoch: "epoch" });
    let projection = projectionWithSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "compaction.start",
        reason: "pending_prompt_size",
        at: "2026-07-15T20:00:01Z",
      }),
    );

    const nowMs = Date.parse("2026-07-15T20:00:06Z");
    const ghost = renderWorkingRow(projection, nowMs, { ghost: true });
    expect(ghost).not.toBeNull();
    // The ghost paints the same copy but never duplicates the semantic hook.
    expect(ghost).not.toContain("data-transcript-status");
    expect(ghost).toContain("Compacting context for ");
    expect(renderWorkingRow(projection, nowMs)).toContain(
      'data-transcript-status="compacting-context"',
    );
  });
});
