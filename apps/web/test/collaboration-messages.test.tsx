import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { decodeServerFrame, type SessionSnapshotFrame } from "@t4-code/protocol";
import type { TranscriptImageSource } from "../src/features/session-runtime/transcript-images.ts";
import { FrameFactory } from "../src/features/session-runtime/frame-builders.ts";
import { initialProjection, reduceTranscript } from "../src/features/transcript/projection.ts";
import { deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { TranscriptRowContent } from "../src/features/transcript/TranscriptRows.tsx";

const IMAGE_SOURCE: TranscriptImageSource = {
  getSnapshot: () => ({ status: "unavailable", reason: "not used" }),
  subscribe: () => () => undefined,
  retain: () => () => undefined,
  reportDecodeFailure: () => undefined,
  dispose: () => undefined,
};

/** Exact output shape of appserver-2 SessionEntryProjector + SessionProjection.snapshot(). */
function appserverSnapshot(input: {
  readonly id: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}): SessionSnapshotFrame {
  const decoded = decodeServerFrame({
    v: "omp-app/1",
    type: "snapshot",
    cursor: { epoch: "epoch", seq: 0 },
    revision: "r-appserver-2-fixture",
    hostId: "host",
    sessionId: "session",
    entries: [
      {
        id: input.id,
        parentId: null,
        hostId: "host",
        sessionId: "session",
        kind: "message",
        timestamp: input.timestamp,
        data: input.data,
      },
    ],
  });
  if (decoded.type !== "snapshot") throw new Error("expected appserver snapshot fixture");
  return decoded;
}

describe("collaboration message projection", () => {
  it("projects exact IRC custom metadata into a contained message row", () => {
    const snapshot = appserverSnapshot({
      id: "irc-1",
      timestamp: "2026-07-15T20:00:00Z",
      data: {
        role: "assistant",
        text: "<irc>machine-facing wrapper that should not be shown</irc>",
        customType: "irc:incoming",
        customDetails: {
          id: "message-1",
          from: "ReviewAgent",
          message: "Found one issue.\nThe retry path needs a guard.",
          replyTo: "message-0",
        },
      },
    });

    const rows = deriveTranscriptRows(reduceTranscript(initialProjection(), snapshot));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe("collaboration");
    if (row?.kind !== "collaboration") throw new Error("expected collaboration row");
    expect(row.message).toMatchObject({
      variant: "irc",
      customType: "irc:incoming",
      from: "ReviewAgent",
      body: "Found one issue.\nThe retry path needs a guard.",
      replyTo: "message-0",
      status: "received",
    });

    const markup = renderToStaticMarkup(
      <TranscriptRowContent
        imageSource={IMAGE_SOURCE}
        nowMs={Date.parse("2026-07-15T20:00:01Z")}
        row={row}
      />,
    );
    expect(markup).toContain('data-collaboration-message="irc:incoming"');
    expect(markup).toContain("ReviewAgent");
    expect(markup).toContain("received");
    expect(markup).toContain("Found one issue.");
    expect(markup).not.toContain("machine-facing wrapper");
  });

  it("keeps assistant prose normal even when it looks exactly like an IRC envelope", () => {
    const snapshot = appserverSnapshot({
      id: "assistant-1",
      timestamp: "2026-07-15T20:00:00Z",
      data: {
        role: "assistant",
        text: "<irc>Incoming IRC message from agent `DefinitelyNotMetadata`</irc>",
      },
    });

    const rows = deriveTranscriptRows(reduceTranscript(initialProjection(), snapshot));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
  });

  it("projects an async subagent result with sender, status, duration, and clean output", () => {
    const snapshot = appserverSnapshot({
      id: "async-1",
      timestamp: "2026-07-15T20:01:00Z",
      data: {
        role: "assistant",
        customType: "async-result",
        customDetails: {
          jobs: [
            {
              jobId: "ReleaseReview",
              type: "task",
              label: "ReleaseReview",
              durationMs: 91_000,
            },
          ],
        },
        text: [
          "<system-notice>Background job completed.</system-notice>",
          '<task-result id="ReleaseReview" agent="reviewer" status="completed" duration="1m31s">',
          '<meta lines="2" size="42B" />',
          "<output>",
          "## Review complete",
          "No blocking findings.",
          "</output>",
          "</task-result>",
        ].join("\n"),
      },
    });

    const rows = deriveTranscriptRows(reduceTranscript(initialProjection(), snapshot));
    const row = rows[0];
    expect(row?.kind).toBe("collaboration");
    if (row?.kind !== "collaboration") throw new Error("expected collaboration row");
    expect(row.message).toMatchObject({
      variant: "task-result",
      from: "reviewer",
      status: "completed",
      body: "## Review complete\nNo blocking findings.",
      jobs: [
        {
          id: "ReleaseReview",
          type: "task",
          label: "ReleaseReview",
          durationMs: 91_000,
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <TranscriptRowContent
        imageSource={IMAGE_SOURCE}
        nowMs={Date.parse("2026-07-15T20:01:01Z")}
        row={row}
      />,
    );
    expect(markup).toContain('data-collaboration-message="async-result"');
    expect(markup).toContain("ReleaseReview");
    expect(markup).toContain("reviewer");
    expect(markup).toContain("completed");
    expect(markup).toContain("1m 31s");
    expect(markup).toContain("Review complete");
    expect(markup).not.toContain("system-notice");
    expect(markup).not.toContain("task-result");
  });

  it("leaves unrelated custom types on the ordinary message path", () => {
    const snapshot = appserverSnapshot({
      id: "custom-1",
      timestamp: "2026-07-15T20:02:00Z",
      data: {
        role: "assistant",
        text: "A future display extension",
        customType: "future:display",
        customDetails: { from: "agent" },
      },
    });

    const rows = deriveTranscriptRows(reduceTranscript(initialProjection(), snapshot));
    expect(rows[0]?.kind).toBe("message");
  });

  it("renders newline-complete durable catch-up once in monotonic cursor order", () => {
    const factory = new FrameFactory({ host: "host", session: "session", epoch: "epoch" });
    let projection = reduceTranscript(initialProjection(), factory.snapshot([]));

    // A partial final JSONL line has no appserver projection entry, so T4 receives no entry frame.
    expect(deriveTranscriptRows(projection)).toEqual([]);
    expect(projection.cursor).toEqual({ epoch: "epoch", seq: 0 });

    const first = factory.entry(
      factory.entryRecord({
        id: "complete-first",
        kind: "message",
        timestamp: "2026-07-16T20:00:01Z",
        data: { role: "assistant", text: "First complete durable line" },
      }),
    );
    projection = reduceTranscript(projection, first);
    const completedProjection = projection;
    let rows = deriveTranscriptRows(projection);
    expect(projection.cursor).toEqual({ epoch: "epoch", seq: 1 });
    expect(rows).toHaveLength(1);
    const firstMarkup = renderToStaticMarkup(
      <TranscriptRowContent
        imageSource={IMAGE_SOURCE}
        nowMs={Date.parse("2026-07-16T20:00:02Z")}
        row={rows[0]!}
      />,
    );
    expect(firstMarkup.match(/First complete durable line/gu)).toHaveLength(1);

    projection = reduceTranscript(projection, first);
    expect(projection).toBe(completedProjection);
    expect(deriveTranscriptRows(projection)).toHaveLength(1);

    for (const [id, text, second] of [
      ["complete-second", "Second complete durable line", 3],
      ["complete-third", "Third complete durable line", 4],
    ] as const) {
      projection = reduceTranscript(
        projection,
        factory.entry(
          factory.entryRecord({
            id,
            kind: "message",
            timestamp: `2026-07-16T20:00:0${second}Z`,
            data: { role: "assistant", text },
          }),
        ),
      );
    }

    rows = deriveTranscriptRows(projection);
    expect(projection.cursor).toEqual({ epoch: "epoch", seq: 3 });
    expect(rows.map((row) => row.id)).toEqual([
      "complete-first",
      "complete-second",
      "complete-third",
    ]);
    const catchUpMarkup = renderToStaticMarkup(
      <>
        {rows.map((row) => (
          <TranscriptRowContent
            imageSource={IMAGE_SOURCE}
            key={row.id}
            nowMs={Date.parse("2026-07-16T20:00:05Z")}
            row={row}
          />
        ))}
      </>,
    );
    for (const text of [
      "First complete durable line",
      "Second complete durable line",
      "Third complete durable line",
    ]) {
      expect(catchUpMarkup.match(new RegExp(text, "gu"))).toHaveLength(1);
    }
  });
});
