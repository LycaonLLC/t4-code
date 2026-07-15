// Exact-metadata projection for display-only collaboration messages. OMP
// persists these as custom messages; its appserver projects the original
// `customType` and bounded `details` into the durable entry data. Never infer
// a collaboration card from assistant prose: without that metadata the entry
// remains a normal assistant/user message.
import type { DurableEntry } from "./projection.ts";

export interface CollaborationJob {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly durationMs: number | null;
}

export type CollaborationMessage =
  | {
      readonly variant: "irc";
      readonly customType: "irc:incoming" | "irc:autoreply" | "irc:relay";
      readonly from: string | null;
      readonly to: string | null;
      readonly body: string;
      readonly replyTo: string | null;
      readonly status: "received" | "auto reply" | "relayed";
      readonly jobs: readonly [];
    }
  | {
      readonly variant: "task-result";
      readonly customType: "async-result";
      readonly from: string | null;
      readonly to: null;
      readonly body: string;
      readonly replyTo: null;
      readonly status: string;
      readonly jobs: readonly CollaborationJob[];
    }
  | {
      readonly variant: "collaborator";
      readonly customType: "collab-prompt";
      readonly from: string | null;
      readonly to: null;
      readonly body: string;
      readonly replyTo: null;
      readonly status: "prompt";
      readonly jobs: readonly [];
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jobsFromDetails(details: Record<string, unknown> | null): CollaborationJob[] {
  if (!Array.isArray(details?.jobs)) return [];
  const jobs: CollaborationJob[] = [];
  for (const value of details.jobs) {
    const job = record(value);
    if (job === null) continue;
    const id = text(job.jobId) ?? text(job.id);
    if (id === null || id.trim() === "") continue;
    jobs.push({
      id,
      type: text(job.type) ?? "task",
      label: text(job.label) ?? id,
      durationMs: finiteNumber(job.durationMs),
    });
  }
  return jobs;
}

interface TaskEnvelope {
  readonly body: string;
  readonly agent: string | null;
  readonly status: string | null;
}

function attribute(header: string, name: string): string | null {
  const marker = `${name}="`;
  const start = header.indexOf(marker);
  if (start === -1) return null;
  const valueStart = start + marker.length;
  const end = header.indexOf('"', valueStart);
  return end === -1 ? null : header.slice(valueStart, end);
}

function taggedBody(segment: string, tag: "output" | "preview"): string | null {
  const start = segment.indexOf(`<${tag}`);
  if (start === -1) return null;
  const contentStart = segment.indexOf(">", start);
  if (contentStart === -1) return null;
  const end = segment.indexOf(`</${tag}>`, contentStart + 1);
  if (end === -1) return null;
  return segment.slice(contentStart + 1, end).trim();
}

/** Decode OMP's machine-owned task envelope only after customType proved it is an async result. */
function taskEnvelopes(content: string): TaskEnvelope[] {
  const envelopes: TaskEnvelope[] = [];
  let offset = 0;
  while (offset < content.length) {
    const start = content.indexOf("<task-result", offset);
    if (start === -1) break;
    const headerEnd = content.indexOf(">", start);
    if (headerEnd === -1) break;
    const close = content.indexOf("</task-result>", headerEnd + 1);
    if (close === -1) break;
    const header = content.slice(start, headerEnd + 1);
    const segment = content.slice(headerEnd + 1, close);
    const body = taggedBody(segment, "output") ?? taggedBody(segment, "preview") ?? segment.trim();
    envelopes.push({
      body,
      agent: attribute(header, "agent"),
      status: attribute(header, "status"),
    });
    offset = close + "</task-result>".length;
  }
  return envelopes;
}

function taskStatus(envelopes: readonly TaskEnvelope[]): string {
  const statuses = envelopes.flatMap((envelope) =>
    envelope.status === null ? [] : [envelope.status.toLowerCase()],
  );
  if (statuses.some((status) => status === "failed" || status === "error")) return "failed";
  if (statuses.some((status) => status === "aborted" || status === "cancelled")) return "aborted";
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
  return "finished";
}

export function collaborationMessageFromEntry(entry: DurableEntry): CollaborationMessage | null {
  if (entry.kind !== "message") return null;
  const customType = text(entry.data.customType);
  if (customType === null) return null;
  const details = record(entry.data.customDetails);
  const rawText = text(entry.data.text) ?? "";

  if (
    customType === "irc:incoming" ||
    customType === "irc:autoreply" ||
    customType === "irc:relay"
  ) {
    const incoming = customType === "irc:incoming";
    return {
      variant: "irc",
      customType,
      from: text(details?.from),
      to: text(details?.to),
      body: (incoming ? text(details?.message) : text(details?.body)) ?? rawText,
      replyTo: text(details?.replyTo),
      status:
        customType === "irc:incoming"
          ? "received"
          : customType === "irc:autoreply"
            ? "auto reply"
            : "relayed",
      jobs: [],
    };
  }

  if (customType === "async-result") {
    const envelopes = taskEnvelopes(rawText);
    const body = envelopes
      .map((envelope) => envelope.body)
      .filter((value) => value !== "")
      .join("\n\n");
    const jobs = jobsFromDetails(details);
    return {
      variant: "task-result",
      customType,
      from:
        envelopes.length === 1
          ? (envelopes[0]?.agent ?? jobs[0]?.label ?? null)
          : jobs.length === 1
            ? (jobs[0]?.label ?? null)
            : null,
      to: null,
      body: body || rawText,
      replyTo: null,
      status: taskStatus(envelopes),
      jobs,
    };
  }

  if (customType === "collab-prompt") {
    return {
      variant: "collaborator",
      customType,
      from: text(details?.from),
      to: null,
      body: rawText,
      replyTo: null,
      status: "prompt",
      jobs: [],
    };
  }

  return null;
}
