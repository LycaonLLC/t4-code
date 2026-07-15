import type { ToolCallState } from "../projection.ts";
import { hasToolRenderer } from "./registry.ts";
import type { ToolResultBlock, ToolResultLike } from "./types.ts";
import { isRecord } from "./util.ts";

export interface AdaptedToolRender {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly intent: string | undefined;
  readonly result: ToolResultLike | undefined;
  readonly known: boolean;
}

export interface ToolRenderInput {
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly state: ToolCallState;
  /** T4 already owns these images through transcript-image metadata. */
  readonly omitInlineImages?: boolean;
}

interface XdevCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface XdevResult {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}

const encoder = new TextEncoder();

function xdevName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name !== "" && encoder.encode(name).byteLength <= 256 && !/[/?#]/u.test(name)
    ? name
    : null;
}

function plainTextXdevArgs(name: string, content: string): Record<string, unknown> | null {
  const text = content.trim();
  switch (name) {
    case "resolve":
    case "reject":
      return { reason: text };
    case "propose":
      return { title: text };
    case "report_issue":
      return { report: text };
    default:
      return null;
  }
}

function plainTextArgKey(name: string): "reason" | "title" | "report" | null {
  switch (name) {
    case "resolve":
    case "reject":
      return "reason";
    case "propose":
      return "title";
    case "report_issue":
      return "report";
    default:
      return null;
  }
}

function xdevExecutionMatches(call: XdevCall | null, result: XdevResult | null): boolean {
  if (call === null || result === null || call.name !== result.name) return false;
  const key = plainTextArgKey(call.name);
  if (key === null) return true;
  const callKeys = Object.keys(call.args);
  const resultKeys = Object.keys(result.args);
  return (
    callKeys.length === 1 &&
    callKeys[0] === key &&
    resultKeys.length === 1 &&
    resultKeys[0] === key &&
    typeof call.args[key] === "string" &&
    call.args[key] === result.args[key]
  );
}

function xdevCall(name: string, value: unknown): XdevCall | null {
  if (name !== "write" || !isRecord(value) || typeof value.path !== "string") return null;
  const path = value.path.trim();
  if (!path.toLowerCase().startsWith("xd://") || typeof value.content !== "string") return null;
  const target = xdevName(path.slice("xd://".length));
  if (!target || encoder.encode(value.content).byteLength > 128 * 1024) return null;
  const plainTextArgs = plainTextXdevArgs(target, value.content);
  if (plainTextArgs !== null) return { name: target, args: plainTextArgs };
  try {
    const args: unknown = JSON.parse(value.content);
    return isRecord(args) ? { name: target, args } : null;
  } catch {
    return null;
  }
}

function xdevResult(value: unknown): XdevResult | null {
  if (!isRecord(value) || !isRecord(value.details) || !isRecord(value.details.xdev)) {
    return null;
  }
  const envelope = value.details.xdev;
  const name = xdevName(envelope.tool);
  if (!name || envelope.mode !== "execute" || !isRecord(envelope.args)) return null;
  const { details: _details, ...outer } = value;
  return {
    name,
    args: envelope.args,
    result: envelope.inner === undefined ? outer : { ...outer, details: envelope.inner },
  };
}

function canonicalName(name: string): string {
  return name.trim().toLowerCase() || "tool";
}

function normalizeArgs(
  name: string,
  value: unknown,
): { readonly args: Record<string, unknown>; readonly intent: string | undefined } {
  if (!isRecord(value)) return { args: {}, intent: undefined };
  const args: Record<string, unknown> = {};
  let intent: string | undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key === "i") {
      if (typeof item === "string" && item.trim() !== "") intent = item.trim();
      continue;
    }
    args[key] = item;
  }

  // T4's earliest durable transcript fixtures used `range` for reads. The OMP
  // renderer calls the same selector `sel`; preserve the old rows without
  // teaching the renderer a second protocol dialect.
  if (name === "read" && typeof args.range === "string" && args.sel === undefined) {
    args.sel = args.range;
  }
  return { args, intent };
}

function normalizeContent(value: unknown, omitImages: boolean): ToolResultBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: ToolResultBlock[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item });
      continue;
    }
    if (!isRecord(item) || typeof item.type !== "string") continue;
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image") {
      if (omitImages) continue;
      if (typeof item.data === "string" && typeof item.mimeType === "string") {
        blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
        continue;
      }
    }
    blocks.push({ type: item.type });
  }
  return blocks;
}

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function legacyText(
  name: string,
  record: Record<string, unknown>,
): { readonly text: string; readonly promotedKey: string | null } | undefined {
  const directKeys = [
    "output",
    "text",
    "preview",
    "summary",
    "analysis",
    "answer",
    "message",
  ] as const;
  const direct = firstText(record, directKeys);
  if (direct !== undefined) {
    const promotedKey = directKeys.find((key) => record[key] === direct) ?? null;
    return { text: direct, promotedKey };
  }
  if (name === "browser") {
    const title = typeof record.title === "string" ? record.title : "";
    const note = typeof record.note === "string" ? record.note : "";
    const combined = [title, note].filter((part) => part !== "").join(" — ");
    if (combined !== "") return { text: combined, promotedKey: null };
  }
  if ((name === "grep" || name === "search") && Array.isArray(record.files)) {
    const files = record.files.filter((file): file is string => typeof file === "string");
    if (files.length > 0) return { text: files.join("\n"), promotedKey: null };
  }
  return undefined;
}

function normalizeDetails(
  name: string,
  record: Record<string, unknown>,
  promotedKey: string | null,
  omitImages: boolean,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      key !== "content" &&
      key !== "details" &&
      key !== "isError" &&
      key !== promotedKey &&
      !(omitImages && key === "images")
    ) {
      details[key] = value;
    }
  }
  if (isRecord(record.details)) {
    for (const [key, value] of Object.entries(record.details)) {
      if (!(omitImages && key === "images")) details[key] = value;
    }
  }

  // Compatibility aliases for T4's original durable result projection.
  if ((name === "grep" || name === "search") && details.matchCount === undefined) {
    if (typeof details.matches === "number") details.matchCount = details.matches;
  }
  if (
    (name === "grep" || name === "search") &&
    details.fileCount === undefined &&
    Array.isArray(details.files)
  ) {
    details.fileCount = details.files.filter((file) => typeof file === "string").length;
  }
  return details;
}

export function adaptToolResult(
  name: string,
  value: unknown,
  state: ToolCallState,
  omitInlineImages = false,
): ToolResultLike | undefined {
  if (!isRecord(value))
    return state === "running" ? undefined : { content: [], isError: state === "error" };
  const content = normalizeContent(value.content, omitInlineImages);
  let promotedKey: string | null = null;
  if (content.length === 0) {
    const legacy = legacyText(name, value);
    if (legacy !== undefined) {
      content.push({ type: "text", text: legacy.text });
      promotedKey = legacy.promotedKey;
    }
  }
  const details = normalizeDetails(name, value, promotedKey, omitInlineImages);
  return {
    content,
    ...(Object.keys(details).length === 0 ? {} : { details }),
    isError: state === "error" || value.isError === true || value.ok === false,
  };
}

export function adaptToolRender(input: ToolRenderInput): AdaptedToolRender {
  const outerName = canonicalName(input.tool);
  const call = xdevCall(outerName, input.args);
  const resultEnvelope = xdevResult(input.result);
  const matched = xdevExecutionMatches(call, resultEnvelope);
  const running = input.state === "running" && call !== null && input.result == null;
  const name = canonicalName(
    matched && resultEnvelope !== null ? resultEnvelope.name : running ? call.name : outerName,
  );
  const rawArgs =
    matched && resultEnvelope !== null ? resultEnvelope.args : running ? call.args : input.args;
  const rawResult = matched && resultEnvelope !== null ? resultEnvelope.result : input.result;
  const { args, intent } = normalizeArgs(name, rawArgs);
  return {
    name,
    args,
    intent,
    result: adaptToolResult(name, rawResult, input.state, input.omitInlineImages),
    known: hasToolRenderer(name),
  };
}
