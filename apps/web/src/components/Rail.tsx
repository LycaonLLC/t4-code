// Project/session rail: grouped rows with explicit state, unread and
// pending-approval markers, keyboard roving, and a collapsed icon strip.
// Row/grouping interaction follows T3's sidebar; rendering is token-native.
import {
  Badge,
  cn,
  IconButton,
  Spinner,
  STATUS_PILLS,
  StatusPill,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import { Cable, ChevronRight, Plus } from "lucide-react";
import { type KeyboardEvent, useCallback, useState } from "react";

import type { WorkspaceSession } from "../lib/workspace-data.ts";
import { formatRelativeTime, type ProjectGroup, type SessionRow } from "../lib/session-tree.ts";
import { createLiveSession } from "../features/session-runtime/live-create.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import { resolveLiveProject } from "../platform/live-workspace.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";

function describeSessionState(session: WorkspaceSession): string {
  if (session.freshness === "offline") return "Offline";
  if (session.freshness === "cached") return "Cached";
  return session.status === null ? "Idle" : "";
}

function SessionRowButton({
  row,
  active,
  index,
  nowMs,
}: {
  row: SessionRow;
  active: boolean;
  index: number;
  nowMs: number;
}) {
  const navigate = useNavigate();
  const { session } = row;
  const stateLabel = describeSessionState(session);
  const ariaState = stateLabel !== "" ? stateLabel : (session.status ?? "idle");
  return (
    <button
      aria-current={active ? "true" : undefined}
      title={session.title}
      aria-label={`${session.title}, ${session.model}, ${ariaState}${row.unread ? ", unread" : ""}`}
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active ? "bg-secondary" : "hover:bg-accent",
        session.freshness === "offline" && "opacity-72",
      )}
      data-session-row={session.id}
      onClick={() => {
        void navigate({ params: { sessionId: session.id }, to: "/sessions/$sessionId" });
      }}
      tabIndex={index === 0 ? 0 : -1}
      type="button"
    >
      <span className="flex w-full items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            active ? "font-medium text-foreground" : "text-foreground",
          )}
        >
          {session.title}
        </span>
        {session.pendingApprovals > 0 && (
          <Badge
            aria-label={`${session.pendingApprovals} waiting for approval`}
            className="shrink-0"
            variant="warning"
          >
            {session.pendingApprovals}
          </Badge>
        )}
        {row.unread && (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-brand" />
        )}
      </span>
      <span className="flex w-full items-center gap-1.5 text-muted-foreground text-xs">
        <span className="truncate font-mono text-[11px]">{session.model}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{formatRelativeTime(session.updatedAt, nowMs)}</span>
        <span className="min-w-0 flex-1" />
        {session.status !== null ? (
          <StatusPill className="shrink-0" status={session.status} />
        ) : (
          stateLabel !== "" && <span className="shrink-0">{stateLabel}</span>
        )}
      </span>
    </button>
  );
}

function ProjectHeaderRow({ group }: { group: ProjectGroup }) {
  const navigate = useNavigate();
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = snapshot !== null ? resolveLiveProject(snapshot, group.project.id) : null;
  const connected = address !== null && snapshot !== null && snapshot.connections.get(address.targetId) === "connected";
  const host = address !== null && snapshot !== null ? snapshot.hosts.get(address.hostId) : undefined;
  const canCreate = connected && host !== undefined && host.grantedCapabilities.includes("sessions.manage");

  const handleCreate = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!canCreate || controller === null || address === null || pending) return;
      setPending(true);
      setError(null);
      try {
        const result = await createLiveSession(controller, address);
        void navigate({ params: { sessionId: result.viewId }, to: "/sessions/$sessionId" });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session creation failed.");
      } finally {
        setPending(false);
      }
    },
    [canCreate, controller, address, pending, navigate],
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-0.5">
        <button
          aria-expanded={group.expanded}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-0"
          onClick={() =>
            workspaceStore.getState().setProjectExpanded(group.project.id, !group.expanded)
          }
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)",
              group.expanded && "rotate-90",
            )}
          />
          <span className="truncate font-medium text-foreground text-xs">{group.project.name}</span>
          {group.host.kind === "remote" && (
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
              <Cable aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{group.host.name}</span>
            </span>
          )}
          <span className="flex-1" />
          {!group.expanded && group.unreadCount > 0 && (
            <span
              aria-label={`${group.unreadCount} unread`}
              className="size-1.5 shrink-0 rounded-full bg-brand"
            />
          )}
          {!group.expanded && group.groupStatus !== null && (
            <StatusPill labelHidden status={group.groupStatus} />
          )}
          <span className="text-muted-foreground text-xs">{group.sessions.length}</span>
        </button>
        {canCreate && (
          <Tooltip>
            <TooltipTrigger
              render={
                <IconButton
                  aria-label={`New session in ${group.project.name}`}
                  className="size-11 shrink-0 sm:size-6"
                  disabled={pending}
                  onClick={handleCreate}
                  size="icon-xs"
                  variant="ghost"
                >
                  {pending ? <Spinner className="size-3" /> : <Plus aria-hidden="true" className="size-3" />}
                </IconButton>
              }
            />
            <TooltipPopup side="right">{`New session in ${group.project.name}`}</TooltipPopup>
          </Tooltip>
        )}
      </div>
      {error !== null && (
        <p className="px-2 pt-0.5 text-destructive-foreground text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Roving focus among session rows: arrows move, Home/End jump. */
function handleRailKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-session-row]")];
  if (rows.length === 0) return;
  const current = rows.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = rows.length - 1;
  else if (event.key === "ArrowDown")
    next = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
  else next = current <= 0 ? 0 : current - 1;
  rows[next]?.focus();
  event.preventDefault();
}

export function Rail({ groups, nowMs }: { groups: readonly ProjectGroup[]; nowMs: number }) {
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  let rowIndex = 0;
  return (
    <nav
      aria-label="Projects and sessions"
      className="flex h-full min-h-0 flex-col overflow-y-auto px-1.5 py-2"
      onKeyDown={handleRailKeyDown}
    >
      {groups.map((group) => (
        <section aria-label={group.project.name} className="mb-1" key={group.project.id}>
          <ProjectHeaderRow group={group} />
          {group.expanded && (
            <div className="mt-0.5 flex flex-col gap-px">
              {group.sessions.map((row) => (
                <SessionRowButton
                  active={row.session.id === activeSessionId}
                  index={rowIndex++}
                  key={row.session.id}
                  nowMs={nowMs}
                  row={row}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </nav>
  );
}

/** 48px icon strip: one identity square per project, tooltip-labeled. */
export function CollapsedRail({
  groups,
  onExpand,
}: {
  groups: readonly ProjectGroup[];
  onExpand: (projectId: string) => void;
}) {
  return (
    <nav
      aria-label="Projects (collapsed list)"
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-border border-r bg-background py-2"
    >
      {groups.map((group) => (
        <Tooltip key={group.project.id}>
          <TooltipTrigger
            render={
              <IconButton
                aria-label={`Show ${group.project.name} sessions`}
                className="relative"
                onClick={() => onExpand(group.project.id)}
                size="icon-sm"
              >
                <span aria-hidden="true" className="font-medium text-xs">
                  {group.project.name.slice(0, 2)}
                </span>
                {(group.groupStatus !== null || group.unreadCount > 0) && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-0.5 right-0.5 size-1.5 rounded-full",
                      group.groupStatus !== null
                        ? STATUS_PILLS[group.groupStatus].dotClass
                        : "bg-brand",
                    )}
                  />
                )}
              </IconButton>
            }
          />
          <TooltipPopup side="right">
            {group.project.name}
            {group.unreadCount > 0 ? ` · ${group.unreadCount} unread` : ""}
          </TooltipPopup>
        </Tooltip>
      ))}
    </nav>
  );
}
