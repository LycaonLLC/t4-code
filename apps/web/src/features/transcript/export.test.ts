// Export contract: the header names the session and says how complete the
// view was; every row kind serializes; unknown entries are preserved, never
// dropped; the transient working row is omitted; Markdown caps long tool
// output while JSON carries rows verbatim; filenames are filesystem-safe.
import { describe, expect, it } from "vite-plus/test";

import {
  EXPORT_TOOL_OUTPUT_MAX_CHARS,
  transcriptFileName,
  transcriptRowsToJson,
  transcriptRowsToMarkdown,
  type ExportMeta,
} from "./export.ts";
import type { TranscriptRow, TranscriptToolCall } from "./rows.ts";

function meta(overrides: Partial<ExportMeta> = {}): ExportMeta {
  return {
    sessionTitle: "Pin protocol fixtures",
    projectName: "t4-code",
    hostName: "studio-mac",
    model: "fable-5",
    freshness: "live",
    exportedAt: "2026-07-19T12:00:00.000Z",
    historyTruncated: false,
    turnActive: false,
    ...overrides,
  };
}

function messageRow(overrides: Partial<Extract<TranscriptRow, { kind: "message" }>> = {}): TranscriptRow {
  return {
    id: "m1",
    kind: "message",
    role: "assistant",
    text: "The build passes.",
    reasoning: "",
    images: [],
    imageIssue: null,
    live: false,
    startedAt: "2026-07-19T11:00:00.000Z",
    ...overrides,
  };
}

function toolCall(overrides: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return {
    callId: "c1",
    tool: "bash",
    title: "Run tests",
    args: { command: "pnpm test" },
    state: "ok",
    startedAt: "2026-07-19T11:01:00.000Z",
    progress: [],
    result: { exitCode: 0 },
    endedAt: "2026-07-19T11:01:30.000Z",
    images: [],
    imageIssue: null,
    ...overrides,
  };
}

describe("transcriptRowsToMarkdown", () => {
  it("writes the provenance header", () => {
    const out = transcriptRowsToMarkdown([], meta());
    expect(out).toContain("# Pin protocol fixtures");
    expect(out).toContain("Project: t4-code · Host: studio-mac · Model: fable-5");
    expect(out).toContain("Exported: 2026-07-19T12:00:00.000Z · View: live");
    expect(out).not.toContain("WARNING");
  });

  it("warns when history was truncated", () => {
    const out = transcriptRowsToMarkdown([], meta({ historyTruncated: true }));
    expect(out).toContain("WARNING: older history was no longer retained");
  });

  it("warns when the view is cached or offline", () => {
    expect(transcriptRowsToMarkdown([], meta({ freshness: "cached" }))).toContain(
      "WARNING: exported from a cached or offline view",
    );
    expect(transcriptRowsToMarkdown([], meta({ freshness: "offline" }))).toContain(
      "WARNING: exported from a cached or offline view",
    );
  });

  it("notes a running turn", () => {
    expect(transcriptRowsToMarkdown([], meta({ turnActive: true }))).toContain(
      "a turn was still running at export time",
    );
  });

  it("serializes a message with reasoning and image count", () => {
    const out = transcriptRowsToMarkdown(
      [
        messageRow({
          role: "user",
          text: "Fix the tests",
          reasoning: "Let me think.",
          images: [{ entryId: "e1", sha256: "ab", mimeType: "image/png" }],
        }),
      ],
      meta(),
    );
    expect(out).toContain("## User");
    expect(out).toContain("Fix the tests");
    expect(out).toContain("> Reasoning: Let me think.");
    expect(out).toContain("_1 image(s) attached_");
  });

  it("serializes tool calls with status, args, and result", () => {
    const out = transcriptRowsToMarkdown(
      [{ id: "g1", kind: "tool-group", calls: [toolCall()], running: false }],
      meta(),
    );
    expect(out).toContain("### Run tests (`bash`) — ok");
    expect(out).toContain('"command": "pnpm test"');
    expect(out).toContain('"exitCode": 0');
  });

  it("marks running and errored calls", () => {
    const out = transcriptRowsToMarkdown(
      [
        {
          id: "g1",
          kind: "tool-group",
          calls: [toolCall({ state: "running" }), toolCall({ callId: "c2", state: "error" })],
          running: true,
        },
      ],
      meta(),
    );
    expect(out).toContain("— running");
    expect(out).toContain("— error");
  });

  it("caps long tool output and says so", () => {
    const big = "x".repeat(EXPORT_TOOL_OUTPUT_MAX_CHARS + 500);
    const out = transcriptRowsToMarkdown(
      [{ id: "g1", kind: "tool-group", calls: [toolCall({ result: { output: big } })], running: false }],
      meta(),
    );
    expect(out).toContain("… truncated for export");
    expect(out.length).toBeLessThan(big.length);
  });

  it("serializes every notice kind", () => {
    const notices: Extract<TranscriptRow, { kind: "notice" }>["notice"][] = [
      { kind: "error", id: "n1", message: "boom", retryable: true, at: "t" },
      { kind: "retry", id: "n2", attempt: 2, reason: "flaky", at: "t" },
      { kind: "compaction", id: "n3", summary: "folded", droppedEntries: 9, at: "t" },
      { kind: "history-truncated", id: "n4", message: "old entries gone" },
      { kind: "gap", id: "n5", reason: "reconnect", missing: 3, at: "t" },
      { kind: "protocol", id: "n6", message: "odd frame", at: "t" },
    ];
    const out = transcriptRowsToMarkdown(
      notices.map((notice, index) => ({ id: `row-${index}`, kind: "notice" as const, notice })),
      meta(),
    );
    expect(out).toContain("> Error: boom");
    expect(out).toContain("> Retry attempt 2: flaky");
    expect(out).toContain("> Context compacted: folded (9 entries dropped)");
    expect(out).toContain("> History truncated: old entries gone");
    expect(out).toContain("> Gap in transcript: reconnect (3 events missing)");
    expect(out).toContain("> Protocol notice: odd frame");
  });

  it("preserves unknown entries instead of dropping them", () => {
    const out = transcriptRowsToMarkdown(
      [
        {
          id: "u1",
          kind: "unknown-entry",
          entryKind: "future-widget",
          data: {},
          timestamp: "2026-07-19T11:02:00.000Z",
        },
      ],
      meta(),
    );
    expect(out).toContain("> Unrecognized entry `future-widget`");
  });

  it("omits the transient working row", () => {
    const out = transcriptRowsToMarkdown(
      [{ id: "w1", kind: "working", startedAt: null, activity: "working" }],
      meta(),
    );
    expect(out).not.toContain("working");
  });
});

describe("transcriptRowsToJson", () => {
  it("carries version, meta, and rows verbatim", () => {
    const big = "x".repeat(EXPORT_TOOL_OUTPUT_MAX_CHARS + 500);
    const rows = [
      messageRow(),
      { id: "g1", kind: "tool-group", calls: [toolCall({ result: { output: big } })], running: false },
    ] as const;
    const parsed = JSON.parse(transcriptRowsToJson(rows, meta()));
    expect(parsed.version).toBe(1);
    expect(parsed.meta.sessionTitle).toBe("Pin protocol fixtures");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].calls[0].result.output).toHaveLength(big.length);
  });
});

describe("transcriptFileName", () => {
  const at = new Date("2026-07-19T12:34:56.000Z");

  it("slugifies the title and stamps the time", () => {
    expect(transcriptFileName("Pin protocol fixtures for CI!", "md", at)).toBe(
      "t4-transcript-pin-protocol-fixtures-for-ci-20260719-123456.md",
    );
  });

  it("falls back when the title has no slug characters", () => {
    expect(transcriptFileName("!!!", "json", at)).toBe(
      "t4-transcript-session-20260719-123456.json",
    );
  });

  it("caps the slug length", () => {
    const name = transcriptFileName("a".repeat(200), "md", at);
    expect(name.length).toBeLessThan(90);
    expect(name.endsWith(".md")).toBe(true);
  });
});
