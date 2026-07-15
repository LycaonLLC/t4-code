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

function legacyText(name: string, record: Record<string, unknown>): string | undefined {
  const direct = firstText(record, [
    "output",
    "text",
    "preview",
    "summary",
    "analysis",
    "answer",
    "message",
  ]);
  if (direct !== undefined) return direct;
  if (name === "browser") {
    const title = typeof record.title === "string" ? record.title : "";
    const note = typeof record.note === "string" ? record.note : "";
    const combined = [title, note].filter((part) => part !== "").join(" — ");
    if (combined !== "") return combined;
  }
  if ((name === "grep" || name === "search") && Array.isArray(record.files)) {
    const files = record.files.filter((file): file is string => typeof file === "string");
    if (files.length > 0) return files.join("\n");
  }
  return undefined;
}

function normalizeDetails(name: string, record: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "content" && key !== "details" && key !== "isError") details[key] = value;
  }
  if (isRecord(record.details)) Object.assign(details, record.details);

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
  if (content.length === 0) {
    const text = legacyText(name, value);
    if (text !== undefined) content.push({ type: "text", text });
  }
  const details = normalizeDetails(name, value);
  return {
    content,
    ...(Object.keys(details).length === 0 ? {} : { details }),
    isError: state === "error" || value.isError === true || value.ok === false,
  };
}

export function adaptToolRender(input: ToolRenderInput): AdaptedToolRender {
  const name = canonicalName(input.tool);
  const { args, intent } = normalizeArgs(name, input.args);
  return {
    name,
    args,
    intent,
    result: adaptToolResult(name, input.result, input.state, input.omitInlineImages),
    known: hasToolRenderer(name),
  };
}
