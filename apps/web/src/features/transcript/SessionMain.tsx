// Center session surface: the streaming transcript with the floating
// composer and its attention stack (approval / question / plan / error).
// State flows one way: the session runtime controller projects app-wire
// frames into a TranscriptProjection; rows derive from the projection; user
// actions leave through typed SessionIntents. The shell's outer scroll
// container stays inert — this surface owns its own virtualized scroller.
import { Badge, cn, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceProject, WorkspaceSession } from "../../lib/workspace-data.ts";
import { workspaceStore } from "../../state/store-instance.ts";
import { Composer } from "../composer/Composer.tsx";
import { getInspectorStore } from "../panes/inspector-store.ts";
import {
  ApprovalPanel,
  AskPanel,
  AttentionStack,
  PlanPanel,
  TurnErrorBanner,
} from "../composer/panels.tsx";
import type { SessionIntent } from "../session-runtime/intents.ts";
import { useSessionRuntime } from "../session-runtime/useSessionRuntime.ts";
import {
  computeStableRows,
  deriveAttention,
  deriveTranscriptRows,
  initialStableRowsState,
  shouldShowAttention,
  type StableRowsState,
} from "./rows.ts";
import { TranscriptTimeline } from "./TranscriptTimeline.tsx";
import type { ToolRenderHost } from "./tool-render/types.ts";

export interface SessionMainProps {
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
  readonly nowMs: number;
}

export function FreshnessBadge({ session }: { readonly session: WorkspaceSession }) {
  if (session.freshness === "cached") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">Cached</Badge>} />
        <TooltipPopup side="bottom">
          Showing the last synced copy. It refreshes when the connection returns.
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (session.freshness === "offline") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">Offline</Badge>} />
        <TooltipPopup side="bottom">
          This session's host is unreachable. Its record stays put until the host returns.
        </TooltipPopup>
      </Tooltip>
    );
  }
  return null;
}

/** Stable-row derivation hook: unchanged rows keep their references. */
function useStableTranscriptRows(rows: ReturnType<typeof deriveTranscriptRows>) {
  const stateRef = useRef<StableRowsState>(initialStableRowsState());
  return useMemo(() => {
    const next = computeStableRows(rows, stateRef.current);
    stateRef.current = next;
    return next.result;
  }, [rows]);
}

type SessionActivity = "compacting" | "working" | null;

function activityLabel(activity: SessionActivity): string {
  if (activity === "compacting") return "Compacting context";
  if (activity === "working") return "Working";
  return "";
}

/**
 * One stable live region owns session activity announcements. Transcript rows
 * remain visual-only so the surrounding role=log cannot announce the same
 * transition a second time.
 */
function SessionActivityAnnouncer({ activity }: { readonly activity: SessionActivity }) {
  const previousRef = useRef<SessionActivity>(activity);
  const [announcement, setAnnouncement] = useState(() => activityLabel(activity));

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = activity;
    if (previous === "compacting" && activity !== "compacting") {
      setAnnouncement(
        activity === "working"
          ? "Context compaction complete. Working"
          : "Context compaction complete",
      );
      return;
    }
    setAnnouncement(activityLabel(activity));
  }, [activity]);

  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-session-activity-announcer
      role="status"
    >
      {announcement}
    </p>
  );
}

export function SessionMain({ session }: SessionMainProps) {
  const archived = session.archivedAt !== undefined;
  const { snapshot, runtime } = useSessionRuntime(session.id, session.freshness);
  const projection = snapshot.projection;
  const toolHost = useMemo<ToolRenderHost>(
    () => ({
      hasAgent: (agentId) =>
        getInspectorStore(session.id)?.getState().agentMap.agents[agentId] !== undefined,
      openAgent: (agentId) => {
        const inspector = getInspectorStore(session.id);
        if (inspector?.getState().agentMap.agents[agentId] === undefined) return;
        inspector.getState().selectAgent(agentId);
        const workspace = workspaceStore.getState();
        const view = workspace.sessionViewById[session.id];
        if (view?.paneFamily !== "agents") workspace.togglePaneFamily(session.id, "agents");
        workspace.setPaneOpen(session.id, true);
      },
    }),
    [session.id],
  );

  const rawRows = useMemo(
    () =>
      deriveTranscriptRows(projection, {
        sessionActive: snapshot.sessionActive,
        pendingPrompts: snapshot.pendingPrompts,
      }),
    [projection, snapshot.pendingPrompts, snapshot.sessionActive],
  );
  const rows = useStableTranscriptRows(rawRows);
  const attention = useMemo(() => deriveAttention(projection), [projection]);

  const [revisingPlanId, setRevisingPlanId] = useState<string | null>(null);
  const onIntent = useCallback(
    (intent: SessionIntent) => {
      if (!archived) runtime.dispatch(intent);
    },
    [archived, runtime],
  );
  const submitPrompt = useCallback(
    (intent: SessionIntent) =>
      archived
        ? Promise.resolve({ kind: "rejected" as const, reason: "Archived sessions are read-only." })
        : runtime.submitPrompt(intent),
    [archived, runtime],
  );

  // Composer dock height feeds the timeline's end inset so following content
  // never hides under the floating composer.
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = useState(120);
  useEffect(() => {
    const element = dockRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      const next = Math.ceil(element.getBoundingClientRect().height);
      setDockHeight((current) => (Math.abs(current - next) < 1 ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const catchingUp = projection.phase === "resyncing" || projection.phase === "paused";
  const sessionActivity: SessionActivity =
    snapshot.link === "live" && !catchingUp && snapshot.sessionActive
      ? projection.contextMaintenance === null
        ? "working"
        : "compacting"
      : null;
  const showAttention = shouldShowAttention(
    attention,
    revisingPlanId,
    archived || snapshot.link !== "live" || catchingUp,
  );

  const retryIntent = useMemo(() => {
    if (attention.error === null || !attention.error.retryable) return null;
    return () => onIntent({ kind: "prompt", text: "/retry", attachments: [] });
  }, [attention.error, onIntent]);

  const empty = rows.length === 0 && !snapshot.sessionActive;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <SessionActivityAnnouncer activity={sessionActivity} key={session.id} />
      {catchingUp && (
        <div
          className="flex h-7 shrink-0 items-center justify-center gap-2 border-border/60 border-b bg-secondary text-muted-foreground text-xs"
          role="status"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-status-working-dot" />
          Catching up — refreshing this transcript from a snapshot
        </div>
      )}
      {archived && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-center border-border/60 border-b bg-secondary px-3 text-center text-muted-foreground text-xs"
          role="status"
        >
          Archived · read-only. Restore this session before continuing work.
        </div>
      )}
      <div aria-label="Transcript" className="relative min-h-0 flex-1" role="log">
        {empty ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-sm text-center text-muted-foreground text-sm">
              Nothing here yet. Say what you need and the work lands in this transcript.
            </p>
          </div>
        ) : (
          <TranscriptTimeline
            bottomInset={archived ? 16 : dockHeight + 16}
            imageSource={runtime.transcriptImages}
            key={session.id}
            nowMs={snapshot.nowMs}
            rows={rows}
            sessionId={session.id}
            streaming={snapshot.sessionActive}
            toolHost={toolHost}
          />
        )}
        {!archived && (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 mx-auto w-full max-w-(--transcript-measure) overflow-x-hidden pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:px-6",
            )}
            ref={dockRef}
          >
            {showAttention && (
              <div className="pointer-events-auto mb-2">
                <AttentionStack>
                  {attention.error !== null && (
                    <TurnErrorBanner error={attention.error} onRetry={retryIntent} />
                  )}
                  {attention.approval !== null && (
                    <ApprovalPanel approval={attention.approval} onIntent={onIntent} />
                  )}
                  {attention.ask !== null && <AskPanel ask={attention.ask} onIntent={onIntent} />}
                  {attention.plan !== null && revisingPlanId === null && (
                    <PlanPanel
                      onIntent={onIntent}
                      onRevise={() => setRevisingPlanId(attention.plan?.planId ?? null)}
                      plan={attention.plan}
                    />
                  )}
                </AttentionStack>
              </div>
            )}
            <Composer
              canCancel={snapshot.canCancel}
              cancelDisabledReason={snapshot.cancelDisabledReason}
              canPrompt={snapshot.canPrompt}
              contextUsedTokens={snapshot.contextUsedTokens}
              contextWindowTokens={snapshot.contextWindowTokens}
              controls={snapshot.controls}
              link={snapshot.link}
              onCancelRevise={() => setRevisingPlanId(null)}
              onIntent={onIntent}
              queuedFollowUps={snapshot.queuedFollowUps}
              revisingPlanId={revisingPlanId}
              sessionId={session.id}
              slashCommands={snapshot.slashCommands}
              submitPrompt={submitPrompt}
              turnActive={snapshot.sessionActive}
            />
          </div>
        )}
      </div>
    </div>
  );
}
