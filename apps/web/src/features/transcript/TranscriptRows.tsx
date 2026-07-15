// Row renderers for the transcript timeline. No card-per-message: user
// messages get a quiet 4% wash block, assistant prose flows on the page, and
// tool work reads as a compact causal group with per-call disclosure.
// Elapsed-time labels self-tick their own text nodes (adapted from T3 Code
// MessagesTimeline `WorkingTimer`, MIT, T3 Tools Inc., commit
// f61fa9499d96fee825492aba204593c37b27e0cb) so a running clock never
// re-renders the list.
import { AnimatedHeight, cn, Spinner } from "@t4-code/ui";
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  FileJson,
  Globe,
  RotateCcw,
  SearchIcon,
  SquarePen,
  Terminal,
  Unplug,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { TranscriptImageSource } from "../session-runtime/transcript-images.ts";
import { useAnchoredDisclosure } from "./disclosure-anchor.tsx";
import { CopyButton, Markdown } from "./Markdown.tsx";
import type { ToolCall, TranscriptNotice } from "./projection.ts";
import { formatElapsed, type TranscriptRow } from "./rows.ts";
import { adaptToolRender } from "./tool-render/adapter.ts";
import { resolveToolRenderer } from "./tool-render/registry.ts";
import type { ToolRenderHost, ToolRenderProps } from "./tool-render/types.ts";
import "./tool-render/tool-render.css";
import { TranscriptImages } from "./TranscriptImages.tsx";

// ---------------------------------------------------------------------------
// Self-ticking elapsed label
// ---------------------------------------------------------------------------

/**
 * First paint is a pure function of (fromIso, nowMs) — reproducible under
 * the fixture runtime's fixed nowMs — then the label ticks forward by real
 * elapsed time from mount, mutating only its own text node.
 */
function ElapsedSince({ fromIso, nowMs }: { readonly fromIso: string; readonly nowMs: number }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [initialText] = useState(() => formatElapsed(fromIso, nowMs));
  useEffect(() => {
    const mountedAt = performance.now();
    const id = setInterval(() => {
      if (textRef.current !== null) {
        textRef.current.textContent = formatElapsed(fromIso, nowMs + performance.now() - mountedAt);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [fromIso, nowMs]);
  return (
    <span className="tabular-nums" ref={textRef}>
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function ReasoningDisclosure({ reasoning }: { readonly reasoning: string }) {
  const [open, setOpen] = useState(false);
  const anchoredToggle = useAnchoredDisclosure();
  return (
    <div className="mb-1.5">
      <button
        aria-expanded={open}
        className={cn(
          "flex min-h-11 cursor-pointer items-center gap-1 rounded-md py-0.5 pr-1.5 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6",
          open && "text-foreground",
        )}
        onClick={(event) => anchoredToggle(event.currentTarget, () => setOpen((value) => !value))}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--motion-duration-fast)",
            open && "rotate-90",
          )}
        />
        Reasoning
      </button>
      <AnimatedHeight>
        {open && (
          <div className="disclosure-content-enter mt-1 border-border border-l pl-3 text-muted-foreground text-xs leading-relaxed">
            <Markdown className="text-xs" text={reasoning} />
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
}

function MessageRow({
  row,
  imageSource,
}: {
  readonly row: Extract<TranscriptRow, { kind: "message" }>;
  readonly imageSource: TranscriptImageSource;
}) {
  if (row.role === "user") {
    return (
      <div className="group/message flex justify-end py-2">
        <div className="relative max-w-[85%] rounded-lg bg-secondary px-3 py-2">
          <Markdown text={row.text} />
          <TranscriptImages
            images={row.images}
            issue={row.imageIssue}
            label="Attached"
            source={imageSource}
          />
          <span className="mt-1 flex justify-end opacity-100 transition-opacity duration-(--motion-duration-fast) sm:absolute sm:-left-8 sm:top-1.5 sm:mt-0 sm:block sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/message:opacity-100">
            <CopyButton label="Copy message" text={row.text} />
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="group/message py-2">
      {row.reasoning !== "" && <ReasoningDisclosure reasoning={row.reasoning} />}
      <Markdown text={row.text} />
      <TranscriptImages
        images={row.images}
        issue={row.imageIssue}
        label="Response"
        source={imageSource}
      />
      <div
        className={cn(
          "mt-1 flex h-11 items-center gap-1 opacity-100 transition-opacity duration-(--motion-duration-fast) sm:h-6 sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/message:opacity-100",
          row.live && "invisible",
        )}
      >
        <CopyButton label="Copy response" text={row.text} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool groups
// ---------------------------------------------------------------------------

const TOOL_META: Record<string, { readonly label: string; readonly Icon: typeof Terminal }> = {
  apply_patch: { label: "Patch", Icon: SquarePen },
  ast_edit: { label: "AST edit", Icon: SquarePen },
  ast_grep: { label: "AST search", Icon: SearchIcon },
  await: { label: "Await", Icon: Terminal },
  bash: { label: "Shell", Icon: Terminal },
  edit: { label: "Edit", Icon: SquarePen },
  fetch: { label: "Fetch", Icon: Globe },
  find: { label: "Find", Icon: SearchIcon },
  glob: { label: "Files", Icon: SearchIcon },
  grep: { label: "Search", Icon: SearchIcon },
  inspect_image: { label: "Image", Icon: Eye },
  job: { label: "Job", Icon: Terminal },
  poll: { label: "Poll", Icon: Terminal },
  puppeteer: { label: "Browser", Icon: Globe },
  read: { label: "Read", Icon: Eye },
  search: { label: "Search", Icon: SearchIcon },
  search_tool_bm25: { label: "Tool search", Icon: SearchIcon },
  ssh: { label: "SSH", Icon: Terminal },
  browser: { label: "Browser", Icon: Globe },
  subagent: { label: "Agent", Icon: Bot },
  task: { label: "Agent", Icon: Bot },
  web_search: { label: "Web search", Icon: Globe },
  write: { label: "Write", Icon: SquarePen },
};

function argText(call: ToolCall, key: string): string {
  const value = call.args[key];
  return typeof value === "string" ? value : "";
}

/** One-line preview under the tool title, per known treatment. */
function toolPreview(call: ToolCall): string {
  switch (call.tool) {
    case "bash":
      return argText(call, "command");
    case "edit": {
      const path = argText(call, "path");
      const additions = call.result?.additions;
      const deletions = call.result?.deletions;
      return typeof additions === "number" && typeof deletions === "number"
        ? `${path}  +${additions} −${deletions}`
        : path;
    }
    case "read": {
      const range = argText(call, "range");
      return range === "" ? argText(call, "path") : `${argText(call, "path")}:${range}`;
    }
    case "search":
      return argText(call, "pattern");
    case "browser":
      return argText(call, "url");
    case "subagent":
      return argText(call, "task") || argText(call, "agent");
    default:
      return "";
  }
}

/** Select the compact secondary label, omitting tool-name duplicates. */
export function toolDetail(call: ToolCall): string {
  const preview = toolPreview(call);
  const detail = preview !== "" ? preview : call.title;
  const normalized = detail.trim().toLowerCase();
  const toolName = call.tool.trim().toLowerCase();
  const primaryLabel = TOOL_META[call.tool]?.label.trim().toLowerCase();
  return normalized === toolName || normalized === primaryLabel ? "" : detail;
}

function humanizeToolName(name: string): string {
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const ToolCallRow = memo(function ToolCallRow({
  call,
  nowMs,
  imageSource,
  toolHost,
}: {
  readonly call: Extract<TranscriptRow, { kind: "tool-group" }>["calls"][number];
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
  readonly toolHost?: ToolRenderHost | undefined;
}) {
  const [open, setOpen] = useState(false);
  const anchoredToggle = useAnchoredDisclosure();
  const view = adaptToolRender({
    tool: call.tool,
    args: call.args,
    result: call.result,
    state: call.state,
    omitInlineImages: call.images.length > 0,
  });
  const renderer = resolveToolRenderer(view.name);
  const Summary = renderer.Summary;
  const Body = renderer.Body;
  const renderProps: ToolRenderProps = {
    name: view.name,
    args: view.args,
    result: view.result,
    running: call.state === "running",
    ...(toolHost === undefined ? {} : { host: toolHost }),
  };
  const meta = TOOL_META[view.name];
  const Icon = meta?.Icon ?? FileJson;
  const label = meta?.label ?? humanizeToolName(view.name);
  return (
    <div>
      <button
        aria-expanded={open}
        className={cn(
          "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
          open && "bg-accent/50",
        )}
        onClick={(event) => anchoredToggle(event.currentTarget, () => setOpen((value) => !value))}
        type="button"
      >
        {call.state === "running" ? (
          <Spinner className="size-3.5 shrink-0 text-status-working" />
        ) : call.state === "error" ? (
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-status-error" />
        ) : (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-xs">{label}</span>
        <span
          className="tv-render tv-summary min-w-0 flex-1 truncate"
          data-tool-renderer={view.known ? "known" : "generic"}
        >
          <Summary {...renderProps} />
        </span>
        {call.state === "running" && (
          <span className="shrink-0 text-muted-foreground text-xs">
            <ElapsedSince fromIso={call.startedAt} nowMs={nowMs} />
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      {call.state === "running" && call.progress.length > 0 && (
        <pre className="mt-0.5 ml-7 max-w-full overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground text-xs leading-relaxed [overflow-wrap:anywhere]">
          {call.progress.join("\n")}
        </pre>
      )}
      <TranscriptImages
        className="mr-1 ml-7"
        images={call.images}
        issue={call.imageIssue}
        label={`${label} result`}
        source={imageSource}
      />
      <AnimatedHeight>
        {open && (
          <div
            className="tv-render tv-render-body disclosure-content-enter mt-1 mb-1.5 ml-7"
            data-tool-renderer={view.known ? "known" : "generic"}
          >
            {view.intent !== undefined && <div className="tv-intent">{view.intent}</div>}
            {Body !== undefined && <Body {...renderProps} />}
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
});

function ToolGroupRow({
  row,
  nowMs,
  imageSource,
  toolHost,
}: {
  readonly row: Extract<TranscriptRow, { kind: "tool-group" }>;
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
  readonly toolHost?: ToolRenderHost | undefined;
}) {
  return (
    <div className="my-1.5 rounded-lg border border-border/60 px-1 py-1">
      {row.calls.map((call) => (
        <ToolCallRow
          call={call}
          imageSource={imageSource}
          key={call.callId}
          nowMs={nowMs}
          toolHost={toolHost}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notices, unknown entries, working indicator
// ---------------------------------------------------------------------------

function noticeContent(notice: TranscriptNotice): {
  readonly Icon: typeof AlertTriangle;
  readonly text: string;
  readonly toneClass: string;
} {
  switch (notice.kind) {
    case "error":
      return {
        Icon: CircleAlert,
        text: notice.message,
        toneClass: "text-destructive-foreground",
      };
    case "retry":
      return {
        Icon: RotateCcw,
        text: `Retry ${notice.attempt}: ${notice.reason}`,
        toneClass: "text-warning-foreground",
      };
    case "compaction":
      return {
        Icon: Archive,
        text: `${notice.summary}${notice.droppedEntries > 0 ? ` (${notice.droppedEntries} entries folded)` : ""}`,
        toneClass: "text-muted-foreground",
      };
    case "gap":
      return {
        Icon: Unplug,
        text: `Stream interrupted: ${notice.reason}. Catching up from a fresh snapshot.`,
        toneClass: "text-warning-foreground",
      };
    case "protocol":
      return {
        Icon: AlertTriangle,
        text: notice.message,
        toneClass: "text-warning-foreground",
      };
  }
}

function NoticeRow({ row }: { readonly row: Extract<TranscriptRow, { kind: "notice" }> }) {
  const { Icon, text, toneClass } = noticeContent(row.notice);
  return (
    <div className={cn("flex items-start gap-2 py-2 text-xs", toneClass)} role="note">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </div>
  );
}

function UnknownEntryRow({
  row,
}: {
  readonly row: Extract<TranscriptRow, { kind: "unknown-entry" }>;
}) {
  const [open, setOpen] = useState(false);
  const anchoredToggle = useAnchoredDisclosure();
  return (
    <div className="py-1">
      <button
        aria-expanded={open}
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
        onClick={(event) => anchoredToggle(event.currentTarget, () => setOpen((value) => !value))}
        type="button"
      >
        <FileJson aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-mono">{row.entryKind}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--motion-duration-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      <AnimatedHeight>
        {open && (
          <pre className="disclosure-content-enter mt-1 ml-7 max-w-full overflow-x-auto rounded-md border border-border bg-(--markdown-codeblock-background) px-2 py-1.5 font-mono text-muted-foreground text-xs">
            {JSON.stringify(row.data, null, 2)}
          </pre>
        )}
      </AnimatedHeight>
    </div>
  );
}

function WorkingRow({
  row,
  nowMs,
}: {
  readonly row: Extract<TranscriptRow, { kind: "working" }>;
  readonly nowMs: number;
}) {
  return (
    <div className="flex items-center gap-2 py-3 text-status-working text-xs">
      <Spinner className="size-3.5" />
      <span>
        Working for <ElapsedSince fromIso={row.startedAt} nowMs={nowMs} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const TranscriptRowContent = memo(function TranscriptRowContent({
  row,
  nowMs,
  imageSource,
  toolHost,
}: {
  readonly row: TranscriptRow;
  /** Elapsed-label time base from the session runtime snapshot. */
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
  readonly toolHost?: ToolRenderHost | undefined;
}) {
  switch (row.kind) {
    case "message":
      return <MessageRow imageSource={imageSource} row={row} />;
    case "tool-group":
      return <ToolGroupRow imageSource={imageSource} nowMs={nowMs} row={row} toolHost={toolHost} />;
    case "notice":
      return <NoticeRow row={row} />;
    case "unknown-entry":
      return <UnknownEntryRow row={row} />;
    case "working":
      return <WorkingRow nowMs={nowMs} row={row} />;
  }
});
