// Activity pane: one chronological stream of everything the session did —
// tools, agents, jobs, system notes, errors, and read-only agent shell
// output. Filter chips, search, pause-without-loss, a redacted raw
// inspector, and copy/export. Rows are uniform 28px and windowed.
import { Badge, cn, IconButton } from "@t4-code/ui";
import {
  Activity as ActivityIcon,
  AlertCircle,
  Bot,
  ChevronRight,
  Copy,
  Download,
  Info,
  Pause,
  Play,
  SquareTerminal,
  Timer,
  Wrench,
  X,
} from "lucide-react";
import { memo, useMemo, useRef, useState, type ComponentType } from "react";
import type * as React from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery.ts";
import { exportActivity, redactPayload, selectVisibleActivity } from "./activity-log.ts";
import { FamilyEmpty } from "./FamilyEmpty.tsx";
import { PaneHeading } from "./PaneHeading.tsx";
import { useVirtualWindow } from "./hooks.ts";
import { useInspector, type InspectorStoreApi } from "./inspector-store.ts";
import type { ActivityEntry, ActivityFilter, ActivityKind } from "./model.ts";

const DENSE_ROW_HEIGHT = 28;
const PHONE_ROW_HEIGHT = 44;

const FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "agents", label: "Agents" },
  { id: "jobs", label: "Jobs" },
  { id: "system", label: "System" },
  { id: "errors", label: "Errors" },
];

const KIND_ICONS: Readonly<Record<ActivityKind, ComponentType<{ className?: string }>>> = {
  tool: Wrench,
  agent: Bot,
  job: Timer,
  system: Info,
  error: AlertCircle,
  shell: SquareTerminal,
};

function timeLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const ActivityRow = memo(function ActivityRow({
  entry,
  expanded,
  onToggle,
  rowHeight,
}: {
  readonly entry: ActivityEntry;
  readonly expanded: boolean;
  readonly onToggle: (seq: number) => void;
  readonly rowHeight: number;
}) {
  const Icon = KIND_ICONS[entry.kind];
  return (
    <button
      aria-expanded={expanded}
      className={cn(
        "group/row flex w-full cursor-pointer items-center gap-2 rounded-md px-2 text-start outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        expanded ? "bg-secondary" : "hover:bg-secondary/60",
      )}
      onClick={() => onToggle(entry.seq)}
      style={{ height: rowHeight }}
      type="button"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          entry.kind === "error" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          entry.kind === "error" && "text-destructive-foreground",
          entry.kind === "shell" && "font-mono",
        )}
      >
        {entry.title}
        {entry.detail !== null && (
          <span className="text-muted-foreground"> · {entry.detail}</span>
        )}
      </span>
      {entry.unknown && (
        <Badge size="sm" variant="warning">
          Unrecognized
        </Badge>
      )}
      <span className="shrink-0 font-mono text-[.6875rem] text-muted-foreground tabular-nums">
        {timeLabel(entry.at)}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-(--motion-duration-fast) group-hover/row:text-muted-foreground",
          expanded && "rotate-90 text-muted-foreground",
        )}
      />
    </button>
  );
});

function ActivityInspector({
  api,
  entry,
}: {
  readonly api: InspectorStoreApi;
  readonly entry: ActivityEntry;
}) {
  const redacted = useMemo(() => JSON.stringify(redactPayload(entry.raw), null, 2), [entry]);
  return (
    <section
      aria-label="Event details"
      className="flex max-h-[45%] shrink-0 flex-col border-border border-t"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-xs">{entry.title}</span>
        {entry.shellOutput !== null && (
          <Badge size="sm" variant="outline">
            Agent shell · read-only
          </Badge>
        )}
        {entry.unknown && (
          <Badge size="sm" variant="warning">
            Unrecognized kind
          </Badge>
        )}
        <IconButton
          aria-label="Copy event JSON"
          onClick={() => void navigator.clipboard.writeText(redacted)}
          size="icon-xs"
        >
          <Copy />
        </IconButton>
        <IconButton
          aria-label="Close event details"
          onClick={() => api.getState().setExpandedActivity(null)}
          size="icon-xs"
        >
          <X />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-2.5">
        {entry.unknown && (
          <p className="pb-1.5 text-muted-foreground text-xs">
            This build does not know this event kind. Payload shown exactly as received.
          </p>
        )}
        {entry.shellOutput !== null ? (
          <pre className="whitespace-pre-wrap break-all rounded-md bg-(--markdown-codeblock-background) px-2.5 py-2 font-mono text-xs leading-relaxed">
            {entry.shellOutput}
          </pre>
        ) : (
          <pre className="whitespace-pre-wrap break-all rounded-md bg-(--markdown-codeblock-background) px-2.5 py-2 font-mono text-xs leading-relaxed">
            {redacted}
          </pre>
        )}
        <p className="pt-1.5 text-[.6875rem] text-muted-foreground">
          Values that look like credentials are hidden before display.
        </p>
      </div>
    </section>
  );
}

export function ActivityPane({ api, trailing }: { readonly api: InspectorStoreApi; readonly trailing?: React.ReactNode | undefined }) {
  const entries = useInspector(api, (state) => state.activity);
  const filter = useInspector(api, (state) => state.activityFilter);
  const query = useInspector(api, (state) => state.activityQuery);
  const pausedAtSeq = useInspector(api, (state) => state.activityPausedAtSeq);
  const expandedSeq = useInspector(api, (state) => state.expandedActivitySeq);
  const sampleMode = useInspector(api, (state) => state.sampleMode);
  const phoneLayout = useMediaQuery("(max-width: 639px)");
  const rowHeight = phoneLayout ? PHONE_ROW_HEIGHT : DENSE_ROW_HEIGHT;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  const visible = useMemo(
    () => selectVisibleActivity(entries, filter, query, pausedAtSeq),
    [entries, filter, query, pausedAtSeq],
  );
  const heldBack =
    pausedAtSeq === null ? 0 : entries.filter((entry) => entry.seq > pausedAtSeq).length;
  const win = useVirtualWindow(listRef, visible.length, rowHeight);
  const expandedEntry =
    expandedSeq === null ? undefined : entries.find((entry) => entry.seq === expandedSeq);

  if (entries.length === 0) return <FamilyEmpty family="activity" />;

  const exportText = () => exportActivity(visible);
  const copyAll = () => {
    void navigator.clipboard.writeText(exportText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };
  const download = () => {
    const blob = new Blob([exportText()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sampleMode ? "activity-sample.json" : "activity.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeading
        family="activity"
        summary={`${entries.length} recorded${pausedAtSeq !== null ? " · paused" : ""}`}
        trailing={trailing}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-border border-b px-2 py-1.5">
        <div
          aria-label="Filter events"
          className="flex w-full flex-wrap items-center gap-0.5 sm:w-auto sm:flex-nowrap"
          role="group"
        >
          {FILTERS.map((chip) => (
            <button
              aria-pressed={filter === chip.id}
              className={cn(
                "h-6 cursor-pointer rounded-md px-2 text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
                filter === chip.id
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
              key={chip.id}
              onClick={() => api.getState().setActivityFilter(chip.id)}
              type="button"
            >
              {chip.label}
            </button>
          ))}
        </div>
        <span className="hidden flex-1 sm:block" />
        <div className="ml-auto flex items-center gap-1 sm:gap-0.5">
          <IconButton
            aria-label={pausedAtSeq === null ? "Pause the stream" : "Resume the stream"}
            aria-pressed={pausedAtSeq !== null}
            className={cn(pausedAtSeq !== null && "bg-secondary")}
            onClick={() => api.getState().setActivityPaused(pausedAtSeq === null)}
            size="icon-xs"
          >
            {pausedAtSeq === null ? <Pause /> : <Play />}
          </IconButton>
          <IconButton aria-label="Copy visible events" onClick={copyAll} size="icon-xs">
            <Copy />
          </IconButton>
          <IconButton aria-label="Download visible events" onClick={download} size="icon-xs">
            <Download />
          </IconButton>
        </div>
      </div>
      <div className="shrink-0 border-border border-b px-2 py-1.5">
        <input
          aria-label="Search events"
          className="h-7 w-full rounded-md border border-input bg-popover px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          onChange={(event) => api.getState().setActivityQuery(event.target.value)}
          placeholder="Search titles, details, agents"
          type="search"
          value={query}
        />
      </div>
      {pausedAtSeq !== null && (
        <button
          className="flex shrink-0 cursor-pointer items-center gap-2 border-border border-b bg-secondary/60 px-3 py-1.5 text-start text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => api.getState().setActivityPaused(false)}
          type="button"
        >
          <ActivityIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="flex-1">
            Paused.{" "}
            {heldBack === 0
              ? "Nothing new yet."
              : `${heldBack} new ${heldBack === 1 ? "event" : "events"} held back — nothing is lost.`}
          </span>
          <span className="font-medium">Resume</span>
        </button>
      )}
      <div
        aria-label="Session events, oldest first"
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1"
        ref={listRef}
        role="log"
      >
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-muted-foreground text-xs">
            Nothing matches this filter{query.trim().length > 0 ? " and search" : ""}.
          </p>
        ) : (
          <>
            <div aria-hidden="true" style={{ height: win.topPad }} />
            {visible.slice(win.start, win.end).map((entry) => (
              <ActivityRow
                entry={entry}
                expanded={entry.seq === expandedSeq}
                key={entry.seq}
                onToggle={(seq) =>
                  api.getState().setExpandedActivity(seq === expandedSeq ? null : seq)
                }
                rowHeight={rowHeight}
              />
            ))}
            <div aria-hidden="true" style={{ height: win.bottomPad }} />
          </>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Events copied to the clipboard." : ""}
      </p>
      {expandedEntry !== undefined && <ActivityInspector api={api} entry={expandedEntry} />}
    </div>
  );
}
