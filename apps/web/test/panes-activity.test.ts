// Activity stream contract: classification, filters, search, pause without
// loss, secret redaction, unknown-event fallback, and export shape.
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_RETENTION_LIMIT,
  appendActivity,
  classifySessionEvent,
  exportActivity,
  redactPayload,
  selectVisibleActivity,
} from "../src/features/panes/activity-log.ts";
import { createInspectorStore } from "../src/features/panes/inspector-store.ts";
import type { ActivityEntry } from "../src/features/panes/model.ts";
import {
  OMP_APPSERVER_SESSION_EVENT_TYPES,
  TRANSCRIPT_SESSION_EVENT_TYPES,
} from "../src/features/session-runtime/session-event-vocabulary.ts";

const AT = "2026-07-11T10:00:00.000Z";

function entry(seq: number, partial: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    seq,
    at: AT,
    kind: "tool",
    title: `entry ${seq}`,
    detail: null,
    agentId: null,
    terminalId: null,
    raw: {},
    unknown: false,
    shellOutput: null,
    ...partial,
  };
}

describe("event classification", () => {
  it("maps known event types onto stream kinds", () => {
    expect(classifySessionEvent({ type: "tool.start", title: "grep" }, 1, AT).kind).toBe("tool");
    expect(classifySessionEvent({ type: "job.end" }, 1, AT).kind).toBe("job");
    expect(classifySessionEvent({ type: "session.error" }, 1, AT).kind).toBe("error");
  });

  it("recognizes every transcript event from the shared vocabulary", () => {
    expect(TRANSCRIPT_SESSION_EVENT_TYPES).toEqual([
      "turn.start",
      "turn.end",
      "message.delta",
      "message.update",
      "message.settled",
      "message.discarded",
      "tool.start",
      "tool.progress",
      "tool.result",
      "approval.request",
      "approval.resolved",
      "ask.request",
      "ask.resolved",
      "plan.ready",
      "plan.resolved",
      "turn.error",
      "turn.retry",
      "compaction",
      "compaction.start",
      "compaction.end",
      "agent.end",
      "tool.end",
      "tool.error",
      "session.compaction",
      "session.retry",
      "session.error",
    ]);
    for (const type of TRANSCRIPT_SESSION_EVENT_TYPES) {
      expect(classifySessionEvent({ type }, 1, AT).unknown, type).toBe(false);
    }
  });

  it("recognizes the complete current OMP appserver event vocabulary", () => {
    for (const type of OMP_APPSERVER_SESSION_EVENT_TYPES) {
      expect(classifySessionEvent({ type }, 1, AT).unknown, type).toBe(false);
    }
    expect(
      classifySessionEvent({ type: "notice", level: "error", message: "failed" }, 1, AT).kind,
    ).toBe("error");
  });

  it("keeps unknown event types in the stream, flagged, with raw payload", () => {
    const result = classifySessionEvent({ type: "custom.telemetry.v2", spanId: "b71" }, 4, AT);
    expect(result.unknown).toBe(true);
    expect(result.kind).toBe("system");
    expect(result.title).toContain("custom.telemetry.v2");
    expect(result.raw).toEqual({ type: "custom.telemetry.v2", spanId: "b71" });
  });

  it("degrades an undecodable payload without throwing", () => {
    const result = classifySessionEvent({ notAnEvent: true }, 9, AT);
    expect(result.unknown).toBe(true);
    expect(result.at).toBe(AT);
  });

  it("carries agent shell chunks as read-only shell evidence", () => {
    const result = classifySessionEvent(
      { type: "shell.output", terminalId: "term-1", data: "$ pnpm test\nok\n" },
      2,
      AT,
    );
    expect(result.kind).toBe("shell");
    expect(result.shellOutput).toBe("$ pnpm test\nok\n");
    expect(result.terminalId).toBe("term-1");
  });
});

describe("filters, search, pause", () => {
  const entries = [
    entry(1, { kind: "tool", title: "grep epoch" }),
    entry(2, { kind: "agent", title: "spawned batch" }),
    entry(3, { kind: "error", title: "soak failed", detail: "code 137" }),
    entry(4, { kind: "shell", title: "agent shell" }),
    entry(5, { kind: "job", title: "reconnect soak" }),
  ];

  it("narrows by filter chip", () => {
    expect(selectVisibleActivity(entries, "errors", "", null).map((e) => e.seq)).toEqual([3]);
    expect(selectVisibleActivity(entries, "system", "", null).map((e) => e.seq)).toEqual([4]);
    expect(selectVisibleActivity(entries, "all", "", null)).toHaveLength(5);
  });

  it("searches title and detail case-insensitively", () => {
    expect(selectVisibleActivity(entries, "all", "SOAK", null).map((e) => e.seq)).toEqual([3, 5]);
    expect(selectVisibleActivity(entries, "all", "137", null).map((e) => e.seq)).toEqual([3]);
  });

  it("pause clips the view at the pause point without losing later entries", () => {
    const paused = selectVisibleActivity(entries, "all", "", 3);
    expect(paused.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Resume: the full log is still there.
    expect(selectVisibleActivity(entries, "all", "", null)).toHaveLength(5);
  });

  it("the store keeps ingesting while paused", () => {
    const store = createInspectorStore({
      sampleMode: true,
      controller: () => ({
        kind: "fixture",
        performControl: () => {},
        performReview: () => {},
        loadDir: () => {},
        loadPreview: () => {},
      }),
    });
    const state = store.getState();
    state.ingestActivity(entry(0, { title: "before pause" }));
    state.setActivityPaused(true);
    state.ingestActivity(entry(0, { title: "while paused" }));
    state.ingestActivity(entry(0, { title: "also while paused" }));
    const { activity, activityPausedAtSeq } = store.getState();
    expect(activity).toHaveLength(3);
    expect(activityPausedAtSeq).toBe(1);
    store.getState().setActivityPaused(false);
    expect(store.getState().activityPausedAtSeq).toBeNull();
  });

  it("retention caps the log at the oldest end", () => {
    let log: readonly ActivityEntry[] = [];
    for (let seq = 1; seq <= ACTIVITY_RETENTION_LIMIT + 5; seq++) {
      log = appendActivity(log, entry(seq));
    }
    expect(log).toHaveLength(ACTIVITY_RETENTION_LIMIT);
    expect(log[0]?.seq).toBe(6);
  });
});

describe("redaction", () => {
  it("replaces secret-looking keys at any depth", () => {
    const redacted = redactPayload({
      type: "session.system",
      authToken: "sample-1",
      nested: { apiKey: "sample-2", host: "bunker-2", authorization: "Bearer x" },
      list: [{ password: "sample-3" }],
    });
    expect(redacted).toEqual({
      type: "session.system",
      authToken: "[redacted]",
      nested: { apiKey: "[redacted]", host: "bunker-2", authorization: "[redacted]" },
      list: [{ password: "[redacted]" }],
    });
  });

  it("export passes every payload through redaction", () => {
    const exported = exportActivity([
      entry(1, { raw: { type: "session.system", credential: "leak-me" } }),
    ]);
    expect(exported).not.toContain("leak-me");
    expect(exported).toContain("[redacted]");
    expect(JSON.parse(exported)).toHaveLength(1);
  });
});
