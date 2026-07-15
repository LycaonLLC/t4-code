// Transcript projection invariants: cursor-gated ordering, id-keyed dedupe,
// live/durable double-render exclusion, attention states, and 10k stress
// stability with structural row sharing. Pure — no DOM.
import { describe, expect, it } from "vite-plus/test";

import { FrameFactory } from "../src/features/session-runtime/frame-builders.ts";
import {
  buildSessionScript,
  FIXTURE_EPOCH_ISO,
  FIXTURE_NOW_MS,
} from "../src/features/session-runtime/fixtures.ts";
import {
  initialProjection,
  reduceTranscript,
  type TranscriptProjection,
} from "../src/features/transcript/projection.ts";
import {
  computeStableRows,
  deriveAttention,
  deriveTranscriptRows,
  formatElapsed,
  initialStableRowsState,
  shouldShowAttention,
} from "../src/features/transcript/rows.ts";
import { toolDetail } from "../src/features/transcript/TranscriptRows.tsx";

function makeFactory(startSeq = 0) {
  return new FrameFactory({ host: "h", session: "s", epoch: "e1", startSeq });
}

function withSnapshot(factory: FrameFactory, count = 2): TranscriptProjection {
  const entries = Array.from({ length: count }, (_, i) =>
    factory.entryRecord({
      id: `settled-${i}`,
      kind: "message",
      timestamp: "2026-07-11T09:00:00Z",
      data: { role: i % 2 === 0 ? "user" : "assistant", text: `settled ${i}` },
    }),
  );
  return reduceTranscript(initialProjection(), factory.snapshot(entries));
}

describe("snapshot install", () => {
  it("installs entries through the cursor and dedupes by entry id", () => {
    const factory = makeFactory(10);
    const dupe = factory.entryRecord({
      id: "same",
      kind: "message",
      timestamp: "t",
      data: { role: "user", text: "once" },
    });
    const projection = reduceTranscript(initialProjection(), factory.snapshot([dupe, dupe]));
    expect(projection.entries.length).toBe(1);
    expect(projection.cursor).toEqual({ epoch: "e1", seq: 10 });
    expect(projection.phase).toBe("active");
  });

  it("drops live buffers the snapshot already settled", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "live-1", role: "assistant", text: "hi" }),
    );
    expect(projection.liveMessages.size).toBe(1);
    const settled = factory.entryRecord({
      id: "live-1",
      kind: "message",
      timestamp: "t",
      data: { role: "assistant", text: "hi there" },
    });
    projection = reduceTranscript(projection, factory.snapshot([settled]));
    expect(projection.liveMessages.size).toBe(0);
  });
});

describe("sequenced frames", () => {
  it("ignores duplicate sequences and applies contiguous ones", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    const event = factory.event({
      type: "message.update",
      entryId: "m1",
      role: "assistant",
      text: "a",
    });
    projection = reduceTranscript(projection, event);
    const afterFirst = projection;
    // Same frame again: duplicate seq → strict no-op, same reference.
    projection = reduceTranscript(projection, event);
    expect(projection).toBe(afterFirst);
  });

  it("pauses the stream on a sequence gap and applies nothing after", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    factory.skip(3);
    const late = factory.event({
      type: "message.update",
      entryId: "m1",
      role: "assistant",
      text: "should not apply",
    });
    projection = reduceTranscript(projection, late);
    expect(projection.phase).toBe("paused");
    expect(projection.liveMessages.size).toBe(0);
    // Later contiguous-looking frames still do not apply while paused.
    const next = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m2", role: "assistant", text: "x" }),
    );
    expect(next).toBe(projection);
  });

  it("pauses on an epoch change", () => {
    const factory = makeFactory();
    const projection = withSnapshot(factory);
    const other = new FrameFactory({ host: "h", session: "s", epoch: "e2", startSeq: 0 });
    const crossed = reduceTranscript(projection, other.event({ type: "turn.start" }));
    expect(crossed.phase).toBe("paused");
  });

  it("recovers from a gap frame via snapshot resync", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(projection, factory.gap("retention window", 5));
    expect(projection.phase).toBe("resyncing");
    projection = reduceTranscript(projection, factory.snapshot(projection.entries));
    expect(projection.phase).toBe("active");
  });

  it("keeps one stable recovery notice and clears it on the fresh snapshot", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);

    projection = reduceTranscript(projection, factory.gap("replay_budget_exceeded", 5));
    const firstGapRows = deriveTranscriptRows(projection).filter(
      (row) => row.kind === "notice" && row.notice.kind === "gap",
    );
    expect(firstGapRows).toHaveLength(1);
    const firstKey = firstGapRows[0]?.id;

    // A repeated server gap while the same session is still resyncing is the
    // same recovery episode, even if its replay boundary advanced.
    const duplicate = reduceTranscript(projection, factory.gap("replay_budget_exceeded", 2));
    expect(duplicate).toBe(projection);
    const duplicateGapRows = deriveTranscriptRows(duplicate).filter(
      (row) => row.kind === "notice" && row.notice.kind === "gap",
    );
    expect(duplicateGapRows).toHaveLength(1);
    expect(duplicateGapRows[0]?.id).toBe(firstKey);

    projection = reduceTranscript(duplicate, factory.snapshot(duplicate.entries));
    expect(projection.phase).toBe("active");
    expect(projection.notices.some((notice) => notice.kind === "gap")).toBe(false);
    expect(
      deriveTranscriptRows(projection).some(
        (row) => row.kind === "notice" && row.notice.kind === "gap",
      ),
    ).toBe(false);

    // A later gap is a new episode and receives a new stable row identity.
    projection = reduceTranscript(projection, factory.gap("retention window", 1));
    const nextGapRows = deriveTranscriptRows(projection).filter(
      (row) => row.kind === "notice" && row.notice.kind === "gap",
    );
    expect(nextGapRows).toHaveLength(1);
    expect(nextGapRows[0]?.id).not.toBe(firstKey);
  });
});

describe("live/durable exclusion", () => {
  it("appends canonical fixture message.delta chunks and keeps update replacement compatibility", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    const fixtureEntryId = "entry-stream-v1-live-1";
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.delta", entryId: fixtureEntryId, text: "Hello" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.delta", entryId: fixtureEntryId, text: " world" }),
    );
    expect(projection.liveMessages.get(fixtureEntryId)?.text).toBe("Hello world");

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: fixtureEntryId,
        role: "assistant",
        text: "Hello world!",
      }),
    );
    expect(projection.liveMessages.get(fixtureEntryId)?.text).toBe("Hello world!");

    const settled = factory.entryRecord({
      id: fixtureEntryId,
      kind: "message",
      timestamp: "2026-07-11T09:00:03Z",
      data: { role: "assistant", text: "Hello world!" },
    });
    projection = reduceTranscript(projection, factory.entry(settled));
    expect(projection.liveMessages.has(fixtureEntryId)).toBe(false);
    expect(projection.entries.at(-1)?.id).toBe(fixtureEntryId);
  });

  it("full accumulating message events replace live text", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m", role: "assistant", text: "Hello" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "m",
        role: "assistant",
        text: "Hello world",
      }),
    );
    expect(projection.liveMessages.get("m")?.text).toBe("Hello world");
    expect(projection.liveMessages.size).toBe(1);
  });

  it("a settled durable entry never double-renders with its live event", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m", role: "assistant", text: "streamed" }),
    );
    const entry = factory.entryRecord({
      id: "m",
      kind: "message",
      timestamp: "t",
      data: { role: "assistant", text: "streamed final" },
    });
    projection = reduceTranscript(projection, factory.entry(entry));
    const rows = deriveTranscriptRows(projection);
    const messageRows = rows.filter((row) => row.kind === "message" && row.id === "m");
    expect(messageRows.length).toBe(1);
    expect(messageRows[0]?.kind === "message" && messageRows[0].live).toBe(false);
    // A stale live update for the settled id is ignored.
    const stale = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m", role: "assistant", text: "stale" }),
    );
    expect(stale.liveMessages.has("m")).toBe(false);
  });

  it("uses message.settled to reconcile different transient and durable ids", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "assistant:stream-7",
        role: "assistant",
        text: "same text can occur more than once",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.settled",
        transientEntryId: "assistant:stream-7",
        entryId: "durable-random-id",
      }),
    );
    expect(projection.liveMessages.has("assistant:stream-7")).toBe(false);
    expect(projection.liveMessages.get("durable-random-id")).toMatchObject({
      entryId: "durable-random-id",
      text: "same text can occur more than once",
    });

    projection = reduceTranscript(
      projection,
      factory.entry(
        factory.entryRecord({
          id: "durable-random-id",
          kind: "message",
          timestamp: "t",
          data: { role: "assistant", text: "same text can occur more than once" },
        }),
      ),
    );
    expect(projection.liveMessages.size).toBe(0);
    const rows = deriveTranscriptRows(projection).filter(
      (row) => row.kind === "message" && row.id === "durable-random-id",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "message" && rows[0].live).toBe(false);
  });
});

describe("attention and notice states", () => {
  it("never exposes interactive attention controls in an archived read-only transcript", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "ask.request",
        askId: "archived-question",
        question: "Choose a path",
        options: [{ id: "one", label: "One" }],
      }),
    );
    const attention = deriveAttention(projection);
    expect(shouldShowAttention(attention, null, false)).toBe(true);
    expect(shouldShowAttention(attention, null, true)).toBe(false);
  });

  it("models approval, ask, and plan requests and their resolution", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "approval.request",
        approvalId: "a1",
        command: "rm -rf /tmp/x",
        args: {},
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "ask.request",
        askId: "q1",
        question: "Which?",
        options: [{ id: "o1", label: "One" }],
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "plan.ready", planId: "p1", title: "Plan", body: "1. do" }),
    );
    let attention = deriveAttention(projection);
    expect(attention.approval?.approvalId).toBe("a1");
    expect(attention.ask?.askId).toBe("q1");
    expect(attention.plan?.planId).toBe("p1");

    projection = reduceTranscript(
      projection,
      factory.event({ type: "approval.resolved", approvalId: "a1" }),
    );
    projection = reduceTranscript(projection, factory.event({ type: "ask.resolved", askId: "q1" }));
    projection = reduceTranscript(
      projection,
      factory.event({ type: "plan.resolved", planId: "p1" }),
    );
    attention = deriveAttention(projection);
    expect(attention.approval).toBeNull();
    expect(attention.ask).toBeNull();
    expect(attention.plan).toBeNull();
  });

  it("projects the real RPC approval shape without a blank card", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "approval.request",
        approvalId: "rpc-confirm-1",
        title: "Apply migration?",
        message: "This rewrites settings.db and creates a backup.",
        responseKind: "confirmed",
        source: "rpc-ui",
      }),
    );
    expect(projection.approval).toMatchObject({
      approvalId: "rpc-confirm-1",
      title: "Apply migration?",
      message: "This rewrites settings.db and creates a backup.",
      command: "",
    });
  });

  it("ends active composer state when agent.end arrives without turn.end", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(projection, factory.event({ type: "turn.start" }));
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "live", text: "partial" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "agent.end", status: "completed", messageCount: 1 }),
    );
    expect(projection.turnActive).toBe(false);
    expect(projection.liveMessages.size).toBe(0);
  });

  it("surfaces error/retry/compaction notices and advances past additive unknown events", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.retry", attempt: 2, reason: "flaky network" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "compaction", summary: "folded", droppedEntries: 3 }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.error", message: "boom", retryable: true }),
    );
    expect(projection.notices.map((notice) => notice.kind)).toEqual([
      "retry",
      "compaction",
      "error",
    ]);
    expect(deriveAttention(projection).error?.retryable).toBe(true);

    projection = reduceTranscript(
      projection,
      factory.event({ type: "wormhole.open", detail: "??" }),
    );
    const unknownCursor = projection.cursor;
    expect(projection.phase).toBe("active");
    expect(projection.notices.map((notice) => notice.kind)).toEqual([
      "retry",
      "compaction",
      "error",
    ]);

    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-11T09:00:00Z" }),
    );
    expect(projection.cursor?.seq).toBe((unknownCursor?.seq ?? 0) + 1);
    expect(projection.turnActive).toBe(true);
  });
});

describe("10k stress projection", () => {
  it("installs 10k entries with at least 30k parts and stays identity-stable", () => {
    const script = buildSessionScript("sess-stream", "stress");
    let projection = initialProjection();
    for (const frame of script.initialFrames) projection = reduceTranscript(projection, frame);
    expect(projection.entries.length).toBe(10_000);

    // Renderable parts: markdown blocks per message (≥3) + tool rows.
    let parts = 0;
    for (const entry of projection.entries) {
      const text = entry.data.text;
      parts += typeof text === "string" ? text.split("\n\n").length : 1;
    }
    expect(parts).toBeGreaterThanOrEqual(30_000);

    const rows = deriveTranscriptRows(projection);
    const stable1 = computeStableRows(rows, initialStableRowsState());

    // An appended live event must not re-create untouched row objects — and
    // a projection change that touches nothing renderable keeps the array.
    const next = reduceTranscript(
      projection,
      script.factory.event({
        type: "message.update",
        entryId: "tail",
        role: "assistant",
        text: "tail",
      }),
    );
    expect(next.entries).toBe(projection.entries); // entries array untouched
    const rows2 = deriveTranscriptRows(next);
    const stable2 = computeStableRows(rows2, stable1);
    for (let i = 0; i < stable1.result.length; i += 1) {
      expect(stable2.result[i]).toBe(stable1.result[i]);
    }
    expect(stable2.result.length).toBe(stable1.result.length + 1);
  });

  it("derives identical row references for an unchanged projection (no timer rerender)", () => {
    const script = buildSessionScript("sess-stream", "default");
    let projection = initialProjection();
    for (const frame of script.initialFrames) projection = reduceTranscript(projection, frame);
    // Rows carry no clock: derive twice, share structurally, expect the
    // exact same array back (the whole-list "second tick" no-op invariant).
    const state1 = computeStableRows(deriveTranscriptRows(projection), initialStableRowsState());
    const state2 = computeStableRows(deriveTranscriptRows(projection), state1);
    expect(state2).toBe(state1);
    expect(state2.result).toBe(state1.result);
  });
});

describe("deterministic clock", () => {
  it("fixtures derive every timestamp from the fixed epoch, never the wall clock", () => {
    const a = buildSessionScript("sess-stream", "default");
    const b = buildSessionScript("sess-stream", "default");
    // Wall-clock anchoring would drift between builds; fixed epoch cannot.
    expect(JSON.stringify(a.initialFrames)).toBe(JSON.stringify(b.initialFrames));
    expect(JSON.stringify(a.liveSteps)).toBe(JSON.stringify(b.liveSteps));
    let projection = initialProjection();
    for (const frame of a.initialFrames) projection = reduceTranscript(projection, frame);
    // First settled entry (the compaction fold) sits exactly 30 minutes
    // before the exported epoch — a fixed instant, byte-identical every run.
    expect(projection.entries[0]?.timestamp).toBe("2026-07-11T08:30:00.000Z");
    // The scripted "now" sits a fixed offset past the epoch.
    expect(FIXTURE_NOW_MS - Date.parse(FIXTURE_EPOCH_ISO)).toBe(750_000);
  });

  it("elapsed labels are a pure function of (fromIso, nowMs)", () => {
    expect(formatElapsed(FIXTURE_EPOCH_ISO, FIXTURE_NOW_MS)).toBe("12m 30s");
    expect(formatElapsed("2026-07-11T09:12:00Z", FIXTURE_NOW_MS)).toBe("30s");
    expect(formatElapsed("2026-07-11T09:59:00Z", FIXTURE_NOW_MS)).toBe("0s"); // future start clamps
  });
});

describe("tool transcript detail", () => {
  const call = (tool: string, title: string, args: Record<string, unknown> = {}) =>
    ({
      tool,
      title,
      args,
      callId: "c",
      state: "ok",
      startedAt: "",
      progress: [],
      result: null,
      endedAt: "",
    }) as never;

  it("suppresses raw and known-label duplicates while keeping meaningful previews", () => {
    expect(toolDetail(call("grep", "grep"))).toBe("");
    expect(toolDetail(call("inspect_image", "inspect_image"))).toBe("");
    expect(toolDetail(call("edit", "EDIT"))).toBe("");
    expect(toolDetail(call("bash", "bash", { command: "pwd" }))).toBe("pwd");
    expect(toolDetail(call("read", "read", { path: "src/file.ts", range: "1-3" }))).toBe(
      "src/file.ts:1-3",
    );
  });
});
