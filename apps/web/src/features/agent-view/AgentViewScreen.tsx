import type { DesktopRuntimeSnapshot } from "@t4-code/client";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  StatusPill,
} from "@t4-code/ui";
import { ArrowLeft, ExternalLink, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";

import { formatElapsed, AGENT_STATE_STYLES } from "../panes/agent-tree.ts";
import type { AgentNode } from "../panes/model.ts";
import { useNowTick } from "../panes/hooks.ts";
import {
  agentCancelAvailability,
  cancelAgentFromView,
  deriveAgentViewGroups,
  type AgentViewGroup,
  type AgentViewRow,
  type AgentViewRuntime,
} from "./model.ts";

interface PendingCancel {
  readonly group: AgentViewGroup;
  readonly row: AgentViewRow;
}

function StateDot({ node }: { readonly node: AgentNode }) {
  const style = AGENT_STATE_STYLES[node.state];
  return (
    <span aria-hidden="true" className="relative flex size-2 shrink-0">
      {style.pulse && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
            style.dotClass,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", style.dotClass)} />
    </span>
  );
}

function AgentCard({
  group,
  nowMs,
  row,
  sampleMode,
  snapshot,
  onCancel,
}: {
  readonly group: AgentViewGroup;
  readonly nowMs: number;
  readonly row: AgentViewRow;
  readonly sampleMode: boolean;
  readonly snapshot: DesktopRuntimeSnapshot | null;
  readonly onCancel: () => void;
}) {
  const { node } = row;
  const style = AGENT_STATE_STYLES[node.state];
  const availability =
    sampleMode || snapshot === null
      ? { enabled: false, reason: "Sample data is local and cannot stop an agent." }
      : agentCancelAvailability(snapshot, group.viewId, node);
  const elapsed = node.state === "running" ? formatElapsed(node.startedAt, nowMs) : "";
  const contextPercent =
    node.contextUsed === null || node.contextLimit === null || node.contextLimit === 0
      ? null
      : Math.round((node.contextUsed / node.contextLimit) * 100);
  return (
    <li className="rounded-xl border border-border bg-card p-3 shadow-sm/5">
      <div className="flex min-w-0 items-center gap-2">
        <StateDot node={node} />
        <h3 className="min-w-0 flex-1 truncate font-medium text-sm">{node.title}</h3>
        {row.resumable === true && node.state === "parked" && (
          <Badge variant="outline">Resumable</Badge>
        )}
        <span className={cn("shrink-0 text-xs", style.textClass)}>{style.label}</span>
      </div>
      {row.task !== null && (
        <p className="mt-1 [overflow-wrap:anywhere] text-foreground/90 text-sm leading-snug">
          {row.task}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {node.model !== null && <span className="font-mono">{node.model}</span>}
        {elapsed !== "" && (
          <span aria-label={`Running for ${elapsed}`} className="font-mono tabular-nums">
            {elapsed}
          </span>
        )}
        {node.currentTool !== null && <span className="font-mono">Tool: {node.currentTool}</span>}
        {contextPercent !== null && (
          <span aria-label={`Context ${contextPercent}% used`}>Context {contextPercent}%</span>
        )}
      </div>
      {node.progress !== null && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
            <span>Progress</span>
            <span>{Math.round(node.progress * 100)}%</span>
          </div>
          <div
            aria-label={`${Math.round(node.progress * 100)}% done`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(node.progress * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
          >
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-(--motion-duration-slow)"
              style={{ width: `${Math.round(node.progress * 100)}%` }}
            />
          </div>
        </div>
      )}
      {node.evidence !== null && (
        <p className="mt-2 [overflow-wrap:anywhere] rounded-md bg-secondary/60 px-2 py-1.5 text-muted-foreground text-xs">
          {node.evidence}
        </p>
      )}
      <div className="mt-3 flex items-center justify-end border-border border-t pt-2">
        <Button
          className="min-h-11 sm:min-h-8"
          disabled={!availability.enabled}
          onClick={onCancel}
          size="sm"
          title={availability.reason ?? undefined}
          variant="destructive-outline"
        >
          Cancel agent
        </Button>
      </div>
    </li>
  );
}

export function AgentViewScreen({
  controller,
  fixtureGroups,
  fixtureNowMs,
  snapshot,
  onBack,
  onOpenSession,
}: {
  readonly controller: AgentViewRuntime | null;
  readonly fixtureGroups?: readonly AgentViewGroup[];
  readonly fixtureNowMs?: number;
  readonly snapshot: DesktopRuntimeSnapshot | null;
  readonly onBack: () => void;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const groups = useMemo(
    () => (snapshot === null ? (fixtureGroups ?? []) : deriveAgentViewGroups(snapshot)),
    [fixtureGroups, snapshot],
  );
  const sampleMode = snapshot === null && fixtureGroups !== undefined;
  const agentCount = groups.reduce((sum, group) => sum + group.agents.length, 0);
  const runningCount = groups.reduce(
    (sum, group) => sum + group.agents.filter(({ node }) => node.state === "running").length,
    0,
  );
  const liveNowMs = useNowTick(runningCount > 0 && !sampleMode);
  const nowMs = sampleMode && fixtureNowMs !== undefined ? fixtureNowMs : liveNowMs;
  const [pending, setPending] = useState<PendingCancel | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const closeDialog = () => {
    if (sending) return;
    setPending(null);
    setError(null);
  };

  const confirmCancel = async () => {
    if (pending === null || controller === null || sending) return;
    setSending(true);
    setError(null);
    try {
      await cancelAgentFromView(controller, pending.group.viewId, pending.row.node);
      setAnnouncement(`Cancellation requested for ${pending.row.node.title}.`);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="surface-subheader flex min-h-14 shrink-0 items-center gap-2 px-3">
        <Button aria-label="Back to sessions" onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft aria-hidden="true" />
          Sessions
        </Button>
        <span aria-hidden="true" className="h-5 w-px bg-border" />
        <UsersRound aria-hidden="true" className="size-4 text-primary" />
        <span className="min-w-0">
          <h1 className="truncate font-semibold text-sm">Agent View</h1>
          <p className="truncate text-muted-foreground text-xs">
            {agentCount} loaded {agentCount === 1 ? "agent" : "agents"} · {runningCount} running
          </p>
        </span>
      </header>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {snapshot === null && fixtureGroups === undefined ? (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>Agent View requires the desktop runtime</EmptyTitle>
            <EmptyDescription>
              Open T4 Code on your desktop to monitor and control agents running on connected hosts.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onBack} variant="outline">
              Back to sessions
            </Button>
          </EmptyContent>
        </Empty>
      ) : groups.length === 0 ? (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>No agents in loaded sessions</EmptyTitle>
            <EmptyDescription>
              Agent View shows agents from the sessions currently loaded by the runtime. Start an
              agent or open its session to load it here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onBack} variant="outline">
              Back to sessions
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            {groups.map((group) => (
              <section aria-labelledby={`agent-session-${group.viewId}`} key={group.viewId}>
                <div className="mb-2 flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <h2
                      className="truncate font-semibold text-sm"
                      id={`agent-session-${group.viewId}`}
                    >
                      {group.session.title}
                    </h2>
                    <p className="truncate text-muted-foreground text-xs">
                      {group.projectName} · {group.session.model} · {group.session.freshness}
                    </p>
                  </span>
                  {group.session.status !== null && (
                    <StatusPill className="shrink-0" status={group.session.status} />
                  )}
                  <Button
                    aria-label={`Open ${group.session.title}`}
                    className="min-h-11 sm:min-h-8"
                    onClick={() => onOpenSession(group.viewId)}
                    size="sm"
                    variant="outline"
                  >
                    Open
                    <ExternalLink aria-hidden="true" />
                  </Button>
                </div>
                <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {group.agents.map((row) => (
                    <AgentCard
                      group={group}
                      key={row.node.id}
                      nowMs={nowMs}
                      onCancel={() => {
                        setError(null);
                        setPending({ group, row });
                      }}
                      row={row}
                      sampleMode={sampleMode}
                      snapshot={snapshot}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      <Dialog onOpenChange={(open) => (open ? undefined : closeDialog())} open={pending !== null}>
        <DialogPopup aria-label="Cancel agent" className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">Cancel “{pending?.row.node.title}”?</DialogTitle>
            <DialogDescription>
              This stops the agent and its descendants in “{pending?.group.session.title}”. Work
              already written to disk stays intact. The host remains the lifecycle authority.
            </DialogDescription>
            {error !== null && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button disabled={sending} onClick={closeDialog} size="sm" variant="ghost">
              Keep running
            </Button>
            <Button
              disabled={sending}
              onClick={() => void confirmCancel()}
              size="sm"
              variant="destructive"
            >
              {sending ? "Requesting…" : "Cancel agent"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
