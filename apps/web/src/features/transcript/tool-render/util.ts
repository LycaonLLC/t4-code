/**
 * Pure helpers shared by tool renderers. Host-agnostic; no DOM beyond
 * `globalThis` feature probes, no host package imports.
 */
import type { ToolResultImage, ToolResultLike } from "./types.ts";

const RESULT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

type ResultImageMimeType = (typeof RESULT_IMAGE_MIME_TYPES)[number];

function isResultImageMimeType(value: unknown): value is ResultImageMimeType {
  return (
    typeof value === "string" &&
    (RESULT_IMAGE_MIME_TYPES as readonly string[]).includes(value)
  );
}

function hasImageSignature(bytes: Uint8Array, mimeType: ResultImageMimeType): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    if (bytes.length < 6) return false;
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

/** Absolute web links only; transcript content never gets an active URL scheme. */
export function safeExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Decode only canonical, signature-matched raster data from legacy inline results. */
export function decodeResultImageBytes(image: ToolResultImage): Uint8Array | null {
  if (
    !isResultImageMimeType(image.mimeType) ||
    image.data.length === 0 ||
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)
  ) {
    return null;
  }
  try {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return hasImageSignature(bytes, image.mimeType) ? bytes : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String passthrough; anything else (including null/undefined) → null. */
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coerce unknown to a display string ("" for null/undefined). */
export function display(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Replace `/Users/<x>` / `/home/<x>` prefix with `~` for display. */
export function shortenPath(p: string): string {
  for (const prefix of ["/Users/", "/home/"]) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      return slash < 0 ? "~" : `~${rest.slice(slash)}`;
    }
  }
  return p;
}

/**
 * Search scope for display: the current `path` argument (else the legacy
 * `paths`), normalized from a single string, a JSON-encoded string array
 * (`'["a.ts","b.ts"]'`), or an actual array into a flat `string[]`. Mirrors the
 * coding-agent `toPathList` so web cards render the same scope the tool searched.
 */
export function scopePaths(args: Record<string, unknown>): string[] {
  const raw = args.path ?? args.paths;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every((p): p is string => typeof p === "string")) {
          return parsed;
        }
      } catch {
        // Not valid JSON — treat the whole string as one path.
      }
    }
    return [raw];
  }
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
  return [];
}

export function truncate(s: string, maxLen = 100): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

/** Collapse all whitespace runs to single spaces (for one-line summaries). */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function replaceTabs(s: string): string {
  return s.replace(/\t/g, "   ");
}

export function stripAnsi(s: string): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  let clean = "";
  let index = 0;
  while (index < s.length) {
    if (s[index] !== escape) {
      clean += s[index];
      index += 1;
      continue;
    }

    const kind = s[index + 1];
    if (kind === "[") {
      index += 2;
      while (index < s.length) {
        const code = s.charCodeAt(index);
        index += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }
    if (kind === "]") {
      index += 2;
      while (index < s.length) {
        if (s[index] === bell) {
          index += 1;
          break;
        }
        if (s[index] === escape && s[index + 1] === "\\") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    // Unknown two-byte escape: remove the introducer and command byte.
    index += kind === undefined ? 1 : 2;
  }
  return clean;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  mdx: "markdown",
  dockerfile: "dockerfile",
  lua: "lua",
  zig: "zig",
  diff: "diff",
  patch: "diff",
};

export function languageFromPath(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? null;
}

/** Joined text blocks of a tool result ("" when absent). */
export function resultTextOf(result: ToolResultLike | undefined): string {
  if (!result) return "";
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

export function resultImagesOf(result: ToolResultLike | undefined): ToolResultImage[] {
  if (!result) return [];
  const images: ToolResultImage[] = [];
  for (const block of result.content) {
    const img = block as Partial<ToolResultImage>;
    if (
      block.type === "image" &&
      typeof img.data === "string" &&
      typeof img.mimeType === "string" &&
      decodeResultImageBytes(img as ToolResultImage) !== null
    ) {
      images.push(img as ToolResultImage);
    }
  }
  return images;
}

/** `result.details` when it is a plain object; renderers narrow field-by-field. */
export function detailsRecord(result: ToolResultLike | undefined): Record<string, unknown> | null {
  return result && isRecord(result.details) ? result.details : null;
}

/** Compact one-line JSON digest of arbitrary args (generic summary fallback). */
export function argsDigest(args: unknown, maxLen = 96): string {
  if (args == null) return "";
  if (isRecord(args) && Object.keys(args).length === 0) return "";
  return truncate(normalizeWs(display(args)), maxLen);
}

interface HljsLike {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

/**
 * Optional syntax highlighter seam. The HTML export page ships highlight.js as
 * a global; the collab-web app does not bundle it. Renderers degrade to plain
 * text when absent.
 */
export function getHljs(): HljsLike | null {
  const candidate = (globalThis as { hljs?: HljsLike }).hljs;
  return candidate && typeof candidate.highlight === "function" ? candidate : null;
}
