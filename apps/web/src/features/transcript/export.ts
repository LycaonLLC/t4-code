// Transcript export: serialize the already-derived transcript rows into a
// downloadable artifact. What you see is what you export — the same rows
// the screen shows, in the same order, with a provenance header that says
// exactly how complete the view was at export time. Markdown caps long tool
// output for readability; both formats omit the transient working indicator.
import type { CollaborationMessage } from "./collaboration-messages.ts";
import type { TranscriptNotice } from "./projection.ts";
import type { TranscriptRow, TranscriptToolCall } from "./rows.ts";

/** Longest tool argument/result block the Markdown format keeps inline. */
export const EXPORT_TOOL_OUTPUT_MAX_CHARS = 4_000;

export interface ExportMeta {
  readonly sessionTitle: string;
  readonly projectName: string;
  readonly hostName: string;
  readonly model: string;
  readonly freshness: "live" | "cached" | "offline";
  /** ISO timestamp of the export itself. */
  readonly exportedAt: string;
  readonly historyTruncated: boolean;
  readonly turnActive: boolean;
}

function metaLines(meta: ExportMeta): string[] {
  const lines = [
    `- Project: ${meta.projectName} · Host: ${meta.hostName} · Model: ${meta.model}`,
    `- Exported: ${meta.exportedAt} · View: ${meta.freshness}`,
  ];
  if (meta.historyTruncated) {
    lines.push("- WARNING: older history was no longer retained; this export is partial.");
  }
  if (meta.freshness !== "live") {
    lines.push("- WARNING: exported from a cached or offline view, not the live host.");
  }
  if (meta.turnActive) {
    lines.push("- Note: a turn was still running at export time.");
  }
  return lines;
}

function boundedBlock(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  if (text.length <= EXPORT_TOOL_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, EXPORT_TOOL_OUTPUT_MAX_CHARS)}\n… truncated for export`;
}

function fencedJson(value: unknown): string {
  const content = boundedBlock(value);
  let longestBacktickRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}json\n${content}\n${fence}`;
}

function toolCallStatus(call: TranscriptToolCall): string {
  if (call.state === "ok") return "ok";
  if (call.state === "error") return "error";
  return "running";
}

function toolCallToMarkdown(call: TranscriptToolCall): string {
  const parts = [`### ${call.title} (\`${call.tool}\`) — ${toolCallStatus(call)}`];
  if (Object.keys(call.args).length > 0) {
    parts.push(`Arguments:\n\n${fencedJson(call.args)}`);
  }
  for (const line of call.progress) {
    parts.push(`> ${line}`);
  }
  if (call.result !== null) {
    parts.push(`Result:\n\n${fencedJson(call.result)}`);
  }
  if (call.images.length > 0) {
    parts.push(`_${call.images.length} image(s) attached_`);
  }
  return parts.join("\n\n");
}

function collaborationToMarkdown(message: CollaborationMessage): string {
  switch (message.variant) {
    case "irc": {
      const from = message.from ?? "unknown";
      return [`### Peer message — ${message.status}`, `From: ${from}`, message.body].join("\n\n");
    }
    case "task-result": {
      const parts = [`### Subagent result — ${message.status}`, message.body];
      for (const job of message.jobs) {
        const duration =
          job.durationMs === null ? "duration unknown" : `${Math.round(job.durationMs / 1000)}s`;
        parts.push(`> Job ${job.label} (${job.type}), ${duration}`);
      }
      return parts.join("\n\n");
    }
    case "collaborator":
      return ["### Collaborator prompt", message.body].join("\n\n");
  }
}

function noticeToMarkdown(notice: TranscriptNotice): string {
  switch (notice.kind) {
    case "error":
      return `> Error: ${notice.message}`;
    case "retry":
      return `> Retry attempt ${notice.attempt}: ${notice.reason}`;
    case "compaction":
      return `> Context compacted: ${notice.summary} (${notice.droppedEntries} entries dropped)`;
    case "history-truncated":
      return `> History truncated: ${notice.message}`;
    case "gap":
      return `> Gap in transcript: ${notice.reason} (${notice.missing} events missing)`;
    case "protocol":
      return `> Protocol notice: ${notice.message}`;
  }
}

function rowToMarkdown(row: TranscriptRow): string | null {
  switch (row.kind) {
    case "message": {
      const parts = [row.role === "user" ? "## User" : "## Assistant"];
      if (row.reasoning !== "") {
        parts.push(`> Reasoning: ${row.reasoning.replace(/\n/g, "\n> ")}`);
      }
      if (row.text !== "") parts.push(row.text);
      if (row.images.length > 0) parts.push(`_${row.images.length} image(s) attached_`);
      if (row.imageIssue !== null) parts.push(`> Image issue: ${row.imageIssue}`);
      return parts.join("\n\n");
    }
    case "tool-group":
      return row.calls.map(toolCallToMarkdown).join("\n\n");
    case "collaboration":
      return collaborationToMarkdown(row.message);
    case "notice":
      return noticeToMarkdown(row.notice);
    case "unknown-entry":
      return `> Unrecognized entry \`${row.entryKind}\` (${row.timestamp})`;
    case "working":
      return null;
  }
}

/**
 * Serialize the rows the screen shows into a Markdown document with a
 * provenance header. Rows in, string out; nothing is invented or dropped
 * except the transient "working" indicator, which the header covers.
 */
export function transcriptRowsToMarkdown(
  rows: readonly TranscriptRow[],
  meta: ExportMeta,
): string {
  const parts = [`# ${meta.sessionTitle}`, ...metaLines(meta)];
  for (const row of rows) {
    const block = rowToMarkdown(row);
    if (block !== null) parts.push(block);
  }
  return `${parts.join("\n\n")}\n`;
}

export interface TranscriptExportDocument {
  readonly version: 1;
  readonly meta: ExportMeta;
  readonly rows: readonly TranscriptRow[];
}

/** What the export menu needs from the session surface at click time. */
export interface ExportContent {
  readonly rows: readonly TranscriptRow[];
  readonly historyTruncated: boolean;
  readonly turnActive: boolean;
}

/**
 * The same durable rows as structured JSON for tooling. Rows are plain
 * serializable data; nothing is capped or reformatted. The transient working
 * indicator is represented by meta.turnActive instead of a synthetic row.
 */
export function transcriptRowsToJson(
  rows: readonly TranscriptRow[],
  meta: ExportMeta,
): string {
  const document: TranscriptExportDocument = {
    version: 1,
    meta,
    rows: rows.filter((row) => row.kind !== "working"),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const SLUG_MAX_CHARS = 48;

/** Filesystem-safe export name: slugged session title plus export time. */
export function transcriptFileName(
  sessionTitle: string,
  extension: "md" | "json",
  exportedAt: Date,
): string {
  const slug =
    sessionTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX_CHARS)
      .replace(/-+$/g, "") || "session";
  const stamp = exportedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  return `t4-transcript-${slug}-${stamp}.${extension}`;
}
