// Agents pane: the live subagent tree, per-agent detail with a read-only
// transcript, and the scoped steer/cancel/wake control seam. Rows subscribe
// to their own node, so a progress frame re-renders exactly one row.
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@t4-code/ui";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type * as React from "react";

import type { TranscriptImageSource } from "../session-runtime/transcript-images.ts";
import { TranscriptRowContent } from "../transcript/TranscriptRows.tsx";
import { initialProjection } from "../transcript/projection.ts";
import { deriveTranscriptRows } from "../transcript/rows.ts";
import type { ToolRenderHost } from "../transcript/tool-render/types.ts";
import { AGENT_STATE_STYLES, buildAgentTreeRows, formatElapsed } from "./agent-tree.ts";
import { FamilyEmpty } from "./FamilyEmpty.tsx";
import { PaneHeading } from "./PaneHeading.tsx";
import { useNowTick } from "./hooks.ts";
import { useInspector, type InspectorStoreApi } from "./inspector-store.ts";
import type { AgentControlScope, AgentNode } from "./model.ts";

const CHILD_TRANSCRIPT_IMAGE_REASON =
  "Image bytes are not available without an active parent-session image source.";
const UNAVAILABLE_CHILD_TRANSCRIPT_IMAGE_SNAPSHOT = Object.freeze({
  status: "unavailable" as const,
  reason: CHILD_TRANSCRIPT_IMAGE_REASON,
});
const UNAVAILABLE_CHILD_TRANSCRIPT_IMAGE_SOURCE: TranscriptImageSource = Object.freeze({
  // useSyncExternalStore requires object snapshots to retain identity until the
  // underlying store changes. This fallback never changes.
  getSnapshot: () => UNAVAILABLE_CHILD_TRANSCRIPT_IMAGE_SNAPSHOT,
  subscribe: () => () => undefined,
  retain: () => () => undefined,
  reportDecodeFailure: () => undefined,
  dispose: () => undefined,
});

function AgentStateDot({ state }: { readonly state: AgentNode["state"] }) {
  const style = AGENT_STATE_STYLES[state];
  return (
    <span aria-hidden="true" className="relative flex size-1.5 shrink-0">
      {style.pulse && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
            style.dotClass,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-1.5 rounded-full", style.dotClass)} />
    </span>
  );
}

/** Self-ticking elapsed label; the interval lives in this leaf only. */
function ElapsedLabel({
  startedAt,
  live,
}: {
  readonly startedAt: string | null;
  readonly live: boolean;
}) {
  const nowMs = useNowTick(live);
  const label = formatElapsed(startedAt, nowMs);
  if (label === "") return null;
  return (
    <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">{label}</span>
  );
}

interface AgentRowProps {
  readonly api: InspectorStoreApi;
  readonly id: string;
  readonly depth: number;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly onSelect: (id: string) => void;
}

const AgentRow = memo(function AgentRow({
  api,
  id,
  depth,
  selected,
  focused,
  onSelect,
}: AgentRowProps) {
  const node = useInspector(api, (state) => state.agentMap.agents[id]);
  if (node === undefined) return null;
  const style = AGENT_STATE_STYLES[node.state];
  const live = node.state === "running";
  return (
    <div
      aria-level={depth + 1}
      aria-selected={selected}
      className={cn(
        "flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 rounded-md pe-2 py-1.5 outline-none transition-colors duration-(--motion-duration-fast) sm:min-h-0",
        selected ? "bg-secondary" : "hover:bg-secondary/60",
        focused && "group-focus-visible/tree:ring-2 group-focus-visible/tree:ring-ring group-focus-visible/tree:ring-offset-1 group-focus-visible/tree:ring-offset-background",
      )}
      id={`agent-row-${id}`}
      onClick={() => onSelect(id)}
      role="treeitem"
      style={{ paddingInlineStart: 8 + Math.min(depth, 4) * 14 }}
      tabIndex={-1}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentStateDot state={node.state} />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{node.title}</span>
        {node.kind === "batch" && (
          <Badge size="sm" variant="outline">
            Batch
          </Badge>
        )}
        <ElapsedLabel live={live} startedAt={node.startedAt} />
        <span className={cn("shrink-0 text-xs", style.textClass)}>{style.label}</span>
      </div>
      {(node.currentTool !== null ||
        node.progress !== null ||
        (node.contextUsed !== null && node.contextLimit !== null)) && (
        <div className="flex min-w-0 items-center gap-2 ps-3.5">
          {node.currentTool !== null && (
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
              {node.currentTool}
            </span>
          )}
          {node.progress !== null && (
            <span
              aria-label={`${Math.round(node.progress * 100)}% done`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(node.progress * 100)}
              className="ms-auto h-0.75 w-16 shrink-0 overflow-hidden rounded-full bg-secondary"
              role="progressbar"
            >
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-(--motion-duration-slow) ease-out"
                style={{ width: `${Math.round(node.progress * 100)}%` }}
              />
            </span>
          )}
          {node.contextUsed !== null && node.contextLimit !== null && (
            <span className="shrink-0 font-mono text-muted-foreground text-xs">
              Context {node.contextUsed}/{node.contextLimit}
            </span>
          )}
        </div>
      )}
      {node.evidence !== null && node.state !== "aborted" && node.state !== "failed" && (
        <p className="min-w-0 [overflow-wrap:anywhere] ps-3.5 text-muted-foreground text-xs">
          {node.evidence}
        </p>
      )}
    </div>
  );
});

function AgentDetail({
  api,
  sessionId,
  id,
  imageSource,
}: {
  readonly api: InspectorStoreApi;
  readonly sessionId: string;
  readonly id: string;
  readonly imageSource: TranscriptImageSource;
}) {
  const node = useInspector(api, (state) => state.agentMap.agents[id]);
  const actions = useInspector(api, (state) => state.actions);
  const transcriptNowMs = useNowTick(false);
  const toolHost = useMemo<ToolRenderHost>(
    () => ({
      hasAgent: (agentId) => api.getState().agentMap.agents[agentId] !== undefined,
      openAgent: (agentId) => {
        if (api.getState().agentMap.agents[agentId] !== undefined) {
          api.getState().selectAgent(agentId);
        }
      },
    }),
    [api],
  );
  const transcriptRows = useMemo(() => {
    if (node === undefined || !node.transcriptReceived) return [];
    return deriveTranscriptRows({
      ...initialProjection(),
      entries: node.transcriptEntries,
      phase: "active",
    });
  }, [node?.transcriptEntries, node?.transcriptReceived]);
  if (node === undefined) return null;
  const style = AGENT_STATE_STYLES[node.state];
  const failed = node.state === "failed" || node.state === "aborted";
  const request = (action: AgentControlScope["action"]) =>
    api.getState().requestControl({ sessionId, agentId: id, agentTitle: node.title, action });
  const facts: Array<{ label: string; value: string; mono: boolean }> = [];
  if (node.model !== null) facts.push({ label: "Model", value: node.model, mono: true });
  if (node.worktree !== null) facts.push({ label: "Worktree", value: node.worktree, mono: true });
  if (node.path !== null) facts.push({ label: "Path", value: node.path, mono: true });
  return (
    <section
      aria-label={`Details for ${node.title}`}
      className="flex max-h-[62%] shrink-0 flex-col border-border border-t"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <AgentStateDot state={node.state} />
        <h3 className="min-w-0 flex-1 truncate font-medium text-sm">{node.title}</h3>
        <span className={cn("shrink-0 text-xs", style.textClass)}>{style.label}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-2">
        {facts.length > 0 && (
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5 pb-1.5 text-xs">
            {facts.map((fact) => (
              <div className="flex min-w-0 max-w-full items-baseline gap-1.5" key={fact.label}>
                <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
                <dd className={cn("min-w-0 truncate", fact.mono && "font-mono")}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {node.evidence !== null && (
          <p
            className={cn(
              "mb-1.5 min-w-0 rounded-md px-2 py-1.5 text-xs [overflow-wrap:anywhere]",
              failed
                ? "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {node.evidence}
          </p>
        )}
        {node.transcriptFreshness === "cached" && (
          <p
            className="mb-1.5 rounded-md bg-secondary px-2 py-1.5 text-muted-foreground text-xs"
            role="status"
          >
            Refreshing this agent&apos;s saved transcript…
          </p>
        )}
        {node.transcriptHistoryTruncated && (
          <p className="mb-1.5 border-border border-l-2 pl-2 text-muted-foreground text-xs">
            Older child-agent activity is outside the retained transcript window.
          </p>
        )}
        {node.transcriptReceived && transcriptRows.length > 0 ? (
          <ol aria-label="Agent transcript (read-only)" className="divide-y divide-border/60">
            {transcriptRows.map((row) => (
              <li className="py-1" key={row.id}>
                <TranscriptRowContent
                  imageSource={imageSource}
                  nowMs={transcriptNowMs}
                  row={row}
                  toolHost={toolHost}
                />
              </li>
            ))}
          </ol>
        ) : node.transcript.length > 0 ? (
          <ol aria-label="Agent transcript (read-only)" className="flex flex-col gap-1.5">
            {node.transcript.map((entry) => (
              <li className="rounded-md bg-secondary/60 px-2 py-1.5" key={entry.id}>
                <span className="block pb-0.5 text-[.6875rem] text-muted-foreground uppercase tracking-wide">
                  {entry.role}
                </span>
                <span
                  className={cn(
                    "block min-w-0 text-xs [overflow-wrap:anywhere]",
                    entry.role === "tool" && "font-mono",
                  )}
                >
                  {entry.text}
                </span>
              </li>
            ))}
          </ol>
        ) : node.transcriptReceived ? (
          <p className="py-1 text-muted-foreground text-xs">
            This agent has not written any transcript entries yet.
          </p>
        ) : (
          <p className="py-1 text-muted-foreground text-xs">
            This host has not sent a transcript for this agent yet.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-border border-t px-3 py-2">
        <Button
          disabled={
            (node.state !== "running" && node.state !== "waiting") || !actions.agentSteer.enabled
          }
          onClick={() => request("steer")}
          size="xs"
          title={actions.agentSteer.reason ?? undefined}
          variant="outline"
        >
          Steer
        </Button>
        <Button
          disabled={
            (node.state !== "parked" && node.state !== "idle") || !actions.agentWake.enabled
          }
          onClick={() => request("wake")}
          size="xs"
          title={actions.agentWake.reason ?? undefined}
          variant="outline"
        >
          Wake
        </Button>
        <Button
          disabled={
            node.state === "completed" ||
            node.state === "failed" ||
            node.state === "aborted" ||
            !actions.agentCancel.enabled
          }
          onClick={() => request("cancel")}
          size="xs"
          title={actions.agentCancel.reason ?? undefined}
          variant="destructive-outline"
        >
          Cancel
        </Button>
        <span className="ml-auto text-muted-foreground text-xs">Read-only transcript</span>
      </div>
    </section>
  );
}

const CONTROL_COPY: Readonly<
  Record<AgentControlScope["action"], { title: string; description: string; confirm: string }>
> = {
  steer: {
    title: "Steer this agent",
    description: "Your note goes only to this agent. It keeps working and reads it next turn.",
    confirm: "Send note",
  },
  cancel: {
    title: "Cancel this agent",
    description:
      "Stops this agent and everything under it. Work already written to disk stays put.",
    confirm: "Cancel agent",
  },
  wake: {
    title: "Wake this agent",
    description: "Brings this agent back to its queue. Nothing else changes.",
    confirm: "Wake agent",
  },
};

function ControlDialog({ api }: { readonly api: InspectorStoreApi }) {
  const pending = useInspector(api, (state) => state.pendingControl);
  const sampleMode = useInspector(api, (state) => state.sampleMode);
  const [message, setMessage] = useState("");
  if (pending === null) return null;
  const copy = CONTROL_COPY[pending.action];
  const close = () => {
    api.getState().requestControl(null);
    setMessage("");
  };
  const confirm = () => {
    if (pending.action === "steer") {
      if (message.trim().length === 0) return;
      api.getState().requestControl({ ...pending, message: message.trim() });
    }
    api.getState().confirmControl();
    setMessage("");
  };
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : close())} open>
      <DialogPopup aria-label={copy.title} className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{copy.title}</DialogTitle>
          <DialogDescription>
            <span className="block font-medium text-foreground">{pending.agentTitle}</span>
            <span className="block pt-1">{copy.description}</span>
            {sampleMode && (
              <span className="block pt-1 text-xs">
                Sample data: this action is recorded locally only.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {pending.action === "steer" && (
          <div className="px-6">
            <textarea
              aria-label="Note for this agent"
              autoFocus
              className="min-h-20 w-full resize-y rounded-lg border border-input bg-popover px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              onChange={(event) => setMessage(event.target.value)}
              placeholder="What should it do differently?"
              value={message}
            />
          </div>
        )}
        <DialogFooter variant="bare">
          <Button onClick={close} size="sm" variant="ghost">
            Keep as is
          </Button>
          <Button
            disabled={pending.action === "steer" && message.trim().length === 0}
            onClick={confirm}
            size="sm"
            variant={pending.action === "cancel" ? "destructive" : "default"}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AgentsPane({
  api,
  sessionId,
  imageSource,
  trailing,
}: {
  readonly api: InspectorStoreApi;
  readonly sessionId: string;
  readonly imageSource?: TranscriptImageSource | undefined;
  readonly trailing?: React.ReactNode | undefined;
}) {
  // Structure fingerprint: rows rebuild only when membership/nesting change,
  // never on progress or state patches.
  const structure = useInspector(api, (state) =>
    state.agentMap.order
      .map((id) => `${id}>${state.agentMap.agents[id]?.parentId ?? ""}`)
      .join("|"),
  );
  const rows = useMemo(() => buildAgentTreeRows(api.getState().agentMap), [api, structure]);
  const selectedId = useInspector(api, (state) => state.selectedAgentId);
  const summary = useInspector(api, (state) => {
    const nodes = state.agentMap.order
      .map((id) => state.agentMap.agents[id])
      .filter((node) => node !== undefined);
    const running = nodes.filter((node) => node.state === "running").length;
    return `${nodes.length} ${nodes.length === 1 ? "agent" : "agents"} · ${running} running`;
  });
  const [focusIndex, setFocusIndex] = useState(0);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const activeIndex = Math.min(focusIndex, Math.max(rows.length - 1, 0));
  const onSelect = useCallback(
    (id: string) => {
      const nextIndex = rows.findIndex((row) => row.id === id);
      if (nextIndex >= 0) setFocusIndex(nextIndex);
      api.getState().selectAgent(id);
      treeRef.current?.focus({ preventScroll: true });
    },
    [api, rows],
  );

  if (rows.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeading family="agents" summary={summary} trailing={trailing} />
        <FamilyEmpty className="min-h-0 flex-1" family="agents" />
      </div>
    );
  }

  const moveFocus = (nextIndex: number) => {
    const clamped = Math.min(Math.max(nextIndex, 0), rows.length - 1);
    setFocusIndex(clamped);
    const row = rows[clamped];
    if (row !== undefined) {
      document.getElementById(`agent-row-${row.id}`)?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeading family="agents" summary={summary} trailing={trailing} />
      <div
        aria-activedescendant={`agent-row-${rows[activeIndex]?.id ?? ""}`}
        aria-label="Agents in this session"
        className="group/tree min-h-0 flex-1 overflow-y-auto p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveFocus(activeIndex + 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(activeIndex - 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            moveFocus(0);
          } else if (event.key === "End") {
            event.preventDefault();
            moveFocus(rows.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const row = rows[activeIndex];
            if (row !== undefined) onSelect(row.id);
          }
        }}
        ref={treeRef}
        role="tree"
        tabIndex={0}
      >
        {rows.map((row, index) => (
          <AgentRow
            api={api}
            depth={row.depth}
            focused={index === activeIndex}
            id={row.id}
            key={row.id}
            onSelect={onSelect}
            selected={row.id === selectedId}
          />
        ))}
      </div>
      {selectedId !== null && (
        <AgentDetail
          api={api}
          id={selectedId}
          imageSource={imageSource ?? UNAVAILABLE_CHILD_TRANSCRIPT_IMAGE_SOURCE}
          sessionId={sessionId}
        />
      )}
      <ControlDialog api={api} />
    </div>
  );
}
