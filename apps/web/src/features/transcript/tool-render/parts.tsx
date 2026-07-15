/**
 * Shared UI primitives for tool renderers. Every renderer composes these
 * instead of inventing new CSS — see tool-render.css for the `tv-` classes.
 */
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import type { ToolRenderHost, ToolResultImage, ToolResultLike } from "./types.ts";
import {
  decodeResultImageBytes,
  getHljs,
  replaceTabs,
  resultImagesOf,
  resultTextOf,
  shortenPath,
  stripAnsi,
} from "./util.ts";

export type Tone = "accent" | "ok" | "err" | "warn";

/** Inline chip. Renders nothing for empty content. */
export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: Tone | undefined;
}): ReactNode {
  if (children == null || children === "" || children === false) return null;
  return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ""}`}>{children}</span>;
}

/** Chip row; falsy items are skipped. Usable inline (summaries) and in bodies. */
export function Badges({ items }: { items: ReadonlyArray<ReactNode> }): ReactNode {
  const visible = items.filter((item) => item != null && item !== "" && item !== false);
  if (visible.length === 0) return null;
  return (
    <span className="tv-badges">
      {visible.map((item, i) => (
        <Badge key={i}>{item}</Badge>
      ))}
    </span>
  );
}

/** File path with optional `:start-end` line range or raw selector suffix. */
export function PathText({
  path,
  from,
  to,
  sel,
}: {
  path: string;
  from?: number | null | undefined;
  to?: number | null | undefined;
  sel?: string | null | undefined;
}): ReactNode {
  let range = "";
  if (from != null || to != null) {
    const start = from ?? 1;
    range = to != null ? `:${start}-${to}` : `:${start}`;
  }
  return (
    <span className="tv-path">
      {shortenPath(path)}
      {range && <span className="tv-lines">{range}</span>}
      {sel && <span className="tv-lines">:{sel}</span>}
    </span>
  );
}

/** Key/value grid. */
export function KvGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className="tv-kv">{children}</div>;
}

export function Kv({ k, children }: { k: ReactNode; children: ReactNode }): ReactNode {
  if (children == null || children === "" || children === false) return null;
  return (
    <>
      <span className="tv-kv-key">{k}</span>
      <span className="tv-kv-val">{children}</span>
    </>
  );
}

function useHighlight(code: string, lang: string | null | undefined): string | null {
  return useMemo(() => {
    if (!lang) return null;
    const hljs = getHljs();
    if (!hljs) return null;
    try {
      if (!hljs.getLanguage(lang)) return null;
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, lang]);
}

export interface OutputProps {
  text: string;
  /** Lines shown before collapsing behind a "more" affordance. */
  maxLines?: number | undefined;
  /** highlight.js language (only applied when the host exposes hljs). */
  lang?: string | null | undefined;
  /** Render in error color. */
  error?: boolean | undefined;
  /** "code": horizontal scroll, inset bg. "plain": soft-wrapped. */
  variant?: "code" | "plain" | undefined;
  /** Uppercase mini-title above the block. */
  title?: string | undefined;
  /** Drop the inset background (inline in flow). */
  bare?: boolean | undefined;
}

export const MAX_TOOL_TEXT_RENDER_CHARS = 64 * 1024;
export const MAX_TOOL_TEXT_RENDER_LINES = 500;
const TOOL_TEXT_HEAD_CHARS = 46 * 1024;
const TOOL_TEXT_TAIL_CHARS = 16 * 1024;
const TOOL_TEXT_HEAD_LINES = 349;
const TOOL_TEXT_TAIL_LINES = 150;

export interface BoundedToolText {
  readonly text: string;
  readonly totalLines: number;
  readonly omittedCharacters: number;
  readonly truncated: boolean;
}

function lineCount(value: string): number {
  if (value === "") return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function prefixEnd(value: string, maxChars: number, maxLines: number): number {
  const limit = Math.min(value.length, maxChars);
  let lines = 1;
  for (let index = 0; index < limit; index += 1) {
    if (value.charCodeAt(index) !== 10) continue;
    if (lines >= maxLines) return index;
    lines += 1;
  }
  return limit;
}

function suffixStart(value: string, maxChars: number, maxLines: number): number {
  const limit = Math.max(0, value.length - maxChars);
  let lines = 1;
  for (let index = value.length - 1; index >= limit; index -= 1) {
    if (value.charCodeAt(index) !== 10) continue;
    if (lines >= maxLines) return index + 1;
    lines += 1;
  }
  return limit;
}

function cleanHead(value: string): string {
  const clean = replaceTabs(stripAnsi(value));
  return clean.slice(0, prefixEnd(clean, TOOL_TEXT_HEAD_CHARS, TOOL_TEXT_HEAD_LINES));
}

function cleanTail(value: string): string {
  const clean = replaceTabs(stripAnsi(value));
  return clean.slice(suffixStart(clean, TOOL_TEXT_TAIL_CHARS, TOOL_TEXT_TAIL_LINES));
}

function cappedToolText(value: string, totalLines: number): BoundedToolText {
  const headEnd = prefixEnd(value, TOOL_TEXT_HEAD_CHARS, TOOL_TEXT_HEAD_LINES);
  const tailStart = Math.max(
    headEnd,
    suffixStart(value, TOOL_TEXT_TAIL_CHARS, TOOL_TEXT_TAIL_LINES),
  );
  const head = cleanHead(value.slice(0, headEnd)).replace(/\n+$/u, "");
  const tail = cleanTail(value.slice(tailStart)).replace(/^\n+/u, "");
  const omittedCharacters = Math.max(0, tailStart - headEnd);
  const marker = `… output capped · ${omittedCharacters.toLocaleString("en-US")} middle characters omitted from ${totalLines.toLocaleString("en-US")} lines …`;
  return {
    text: `${head}\n${marker}\n${tail}`,
    totalLines,
    omittedCharacters,
    truncated: true,
  };
}

/**
 * Build a hard-bounded head/tail display window before splitting, mapping, or
 * syntax highlighting. The original result stays available through OMP's
 * artifact notice; a disclosure can never expand thousands of DOM rows.
 */
export function boundToolTextForDisplay(value: string): BoundedToolText {
  const rawLines = lineCount(value);
  if (value.length > MAX_TOOL_TEXT_RENDER_CHARS || rawLines > MAX_TOOL_TEXT_RENDER_LINES) {
    return cappedToolText(value, rawLines);
  }
  const clean = replaceTabs(stripAnsi(value)).replace(/\n+$/u, "");
  const cleanLines = lineCount(clean);
  if (clean.length > MAX_TOOL_TEXT_RENDER_CHARS || cleanLines > MAX_TOOL_TEXT_RENDER_LINES) {
    return cappedToolText(clean, cleanLines);
  }
  return { text: clean, totalLines: cleanLines, omittedCharacters: 0, truncated: false };
}

/**
 * Expandable text block — the workhorse for command output, file previews,
 * search results. Tabs are widened, ANSI escapes stripped.
 */
export function Output({
  text,
  maxLines = 10,
  lang,
  error,
  variant = "plain",
  title,
  bare,
}: OutputProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const bounded = useMemo(() => boundToolTextForDisplay(text), [text]);
  const lines = useMemo(() => bounded.text.split("\n"), [bounded.text]);
  const collapsible = bounded.truncated || lines.length > maxLines + 1;
  const shown = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : bounded.text;
  const html = useHighlight(shown, error ? null : lang);
  const classes = ["tv-pre"];
  if (variant === "plain") classes.push("tv-pre--wrap");
  if (error) classes.push("tv-pre--error");
  if (bare) classes.push("tv-pre--bare");
  return (
    <div className="tv-out">
      {title && <div className="tv-out-title">{title}</div>}
      {html !== null ? (
        <pre
          className={classes.join(" ")}
          dangerouslySetInnerHTML={{ __html: html }}
          id={contentId}
        />
      ) : (
        <pre className={classes.join(" ")} id={contentId}>
          {shown}
        </pre>
      )}
      {collapsible && (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          type="button"
          className="tv-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? bounded.truncated
              ? "collapse bounded preview"
              : "collapse"
            : bounded.truncated
              ? `⋯ ${bounded.totalLines.toLocaleString("en-US")} lines · bounded preview`
              : `⋯ ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

/** Source-code block: inset background, no soft wrap, optional title chip. */
export function CodeBlock({
  code,
  lang,
  title,
  maxLines = 14,
}: {
  code: string;
  lang?: string | null | undefined;
  title?: string | undefined;
  maxLines?: number | undefined;
}): ReactNode {
  if (!code) return null;
  return <Output text={code} lang={lang} maxLines={maxLines} variant="code" title={title} />;
}

/**
 * Result text of a tool result, styled for success or error automatically.
 * Renders nothing when the result is absent or has no text.
 */
export function ResultText({
  result,
  maxLines = 10,
  lang,
  variant,
  title,
}: {
  result: ToolResultLike | undefined;
  maxLines?: number | undefined;
  lang?: string | null | undefined;
  variant?: "code" | "plain" | undefined;
  title?: string | undefined;
}): ReactNode {
  const text = resultTextOf(result).trim();
  if (!text) return null;
  return (
    <Output
      text={text}
      maxLines={maxLines}
      lang={result?.isError ? null : lang}
      error={result?.isError === true}
      variant={variant ?? (lang ? "code" : "plain")}
      title={title}
    />
  );
}

function openImage(img: ToolResultImage): void {
  try {
    const bytes = decodeResultImageBytes(img);
    if (bytes === null) return;
    const url = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: img.mimeType }),
    );
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    // undecodable image data — the broken thumbnail already conveys it
  }
}

/** Thumbnails for every image block in a result; click opens full size. */
export function ResultImages({ result }: { result: ToolResultLike | undefined }): ReactNode {
  const images = resultImagesOf(result);
  if (images.length === 0) return null;
  return (
    <div className="tv-imgs">
      {images.map((img, i) => (
        <button
          aria-label={`Open tool result image ${i + 1}`}
          className="tv-image-button"
          key={i}
          onClick={() => openImage(img)}
          type="button"
        >
          <img
            alt=""
            className="tv-img"
            decoding="async"
            loading="lazy"
            src={`data:${img.mimeType};base64,${img.data}`}
          />
        </button>
      ))}
    </div>
  );
}

/** Callout block. */
export function Note({
  tone,
  children,
}: {
  tone?: "err" | "warn" | "ok";
  children: ReactNode;
}): ReactNode {
  if (children == null || children === "" || children === false) return null;
  return <div className={`tv-note${tone ? ` tv-note--${tone}` : ""}`}>{children}</div>;
}

/** Labeled row inside a `.tv-list`. */
export function Row({ k, children }: { k?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="tv-row">
      {k != null && k !== "" && <span className="tv-row-key">{k}</span>}
      <span className="tv-row-val">{children}</span>
    </div>
  );
}

/** Marker for arguments that arrived with the wrong JSON type. */
export function InvalidArg({ what }: { what?: string }): ReactNode {
  return <span className="tv-err-text">[invalid {what ?? "arg"}]</span>;
}

/**
 * Unified-diff-ish block: `+` rows added, `-` rows removed, `@@` hunk headers
 * faint, blank rows render as `…` gaps (non-contiguous regions).
 */
export function DiffBlock({ diff, maxLines = 80 }: { diff: string; maxLines?: number }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const bounded = useMemo(() => boundToolTextForDisplay(diff), [diff]);
  const lines = useMemo(() => bounded.text.split("\n"), [bounded.text]);
  const collapsible = bounded.truncated || lines.length > maxLines + 1;
  const shown = collapsible && !expanded ? lines.slice(0, maxLines) : lines;
  return (
    <div className="tv-out">
      <div className="tv-diff" id={contentId}>
        {shown.map((line, i) => {
          let cls = "";
          if (line.trim().length === 0) cls = "--gap";
          else if (line.startsWith("… output capped")) cls = "--hunk";
          else if (line.startsWith("+")) cls = "--add";
          else if (line.startsWith("-")) cls = "--del";
          else if (line.startsWith("@@")) cls = "--hunk";
          return (
            <div key={i} className={`tv-diff-row${cls ? ` tv-diff-row${cls}` : ""}`}>
              {line.trim().length === 0 ? "…" : line}
            </div>
          );
        })}
      </div>
      {collapsible && (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          type="button"
          className="tv-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? bounded.truncated
              ? "collapse bounded preview"
              : "collapse"
            : bounded.truncated
              ? `⋯ ${bounded.totalLines.toLocaleString("en-US")} lines · bounded preview`
              : `⋯ ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

/**
 * Agent id chip. Becomes a drill-down button when the host can open that
 * agent's sub-session; otherwise renders as a plain accent badge.
 */
export function AgentLink({
  id,
  host,
  children,
}: {
  id: string;
  host?: ToolRenderHost | undefined;
  children?: ReactNode | undefined;
}): ReactNode {
  const clickable =
    host?.openAgent !== undefined && (host.hasAgent === undefined || host.hasAgent(id));
  if (!clickable) return <Badge tone="accent">{children ?? id}</Badge>;
  return (
    <button
      type="button"
      className="tv-badge tv-badge--accent tv-agent-link"
      onClick={() => host.openAgent?.(id)}
    >
      {children ?? id}
      <span className="tv-agent-link-arrow" aria-hidden="true">
        {" ↗"}
      </span>
    </button>
  );
}
