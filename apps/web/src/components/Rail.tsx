// Project/session rail: grouped rows with explicit state, unread and
// pending-approval markers, keyboard roving, and a collapsed icon strip.
// Row/grouping interaction follows T3's sidebar; rendering is token-native.
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Spinner,
  StatusPill,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Cable,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

import type { SessionListView, WorkspaceSession } from "../lib/workspace-data.ts";
import { formatRelativeTime, type ProjectGroup, type SessionRow } from "../lib/session-tree.ts";
import { composerStore } from "../features/composer/composer-store.ts";
import { createLiveSession } from "../features/session-runtime/live-create.ts";
import {
  archiveLiveSession,
  deleteLiveSession,
  managementCommandSupport,
  renameLiveSession,
  restoreLiveSession,
  sessionCreateSupport,
  terminateLiveSession,
} from "../features/session-runtime/session-management.ts";
import { resolveSessionManagementNavigation } from "../features/session-runtime/session-navigation.ts";
import { presentSessionControlKind } from "../features/session-runtime/session-observer.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import {
  deriveWorkspaceData,
  requiresProfileChoiceForCreate,
  resolveLiveProject,
  resolveLiveProjectCreateTargets,
  resolveLiveSession,
} from "../platform/live-workspace.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { SessionListTabs } from "./SessionListTabs.tsx";

function describeSessionState(session: WorkspaceSession): string {
  if (session.freshness === "offline") return "Offline";
  if (session.freshness === "cached") return "Cached";
  // Owner kind is never proven across the wire, so labels stay generic —
  // and only a confirmed live lock reads "Active elsewhere".
  if (session.control !== undefined) return presentSessionControlKind(session.control).railLabel;
  return session.status === null ? "Idle" : "";
}

type SessionDialog = "rename" | "terminate" | "delete" | null;
type SessionAction = "rename" | "terminate" | "archive" | "restore" | "delete";

function SessionRowItem({
  row,
  active,
  index,
  nowMs,
  onAnnounce,
}: {
  row: SessionRow;
  active: boolean;
  index: number;
  nowMs: number;
  onAnnounce: (message: string) => void;
}) {
  const navigate = useNavigate();
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const { session } = row;
  const stateLabel = describeSessionState(session);
  const ariaState = stateLabel !== "" ? stateLabel : (session.status ?? "idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<SessionDialog>(null);
  const [renameValue, setRenameValue] = useState(session.title);
  const [deleteValue, setDeleteValue] = useState("");
  const [pending, setPending] = useState<SessionAction | null>(null);
  const pendingRef = useRef<SessionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = snapshot === null ? null : resolveLiveSession(snapshot, session.id);
  const archived = session.archivedAt !== undefined;

  const support = (
    command:
      | "session.rename"
      | "session.close"
      | "session.archive"
      | "session.restore"
      | "session.delete",
  ) =>
    snapshot === null || address === null
      ? { supported: false, reason: "Connect to this host to manage the session" }
      : managementCommandSupport(snapshot, address, command);
  const renameSupport = support("session.rename");
  const terminateSupport = support("session.close");
  const archiveSupport = support("session.archive");
  const restoreSupport = support("session.restore");
  const deleteSupport = support("session.delete");
  const workingReason =
    archiveSupport.reason === "Terminate the runtime before archiving or deleting it" ||
    deleteSupport.reason === "Terminate the runtime before archiving or deleting it"
      ? "Terminate the runtime before archiving or deleting it"
      : null;

  const runAction = useCallback(
    async (action: SessionAction) => {
      if (pendingRef.current !== null || controller === null || address === null) return;
      pendingRef.current = action;
      setPending(action);
      setError(null);
      try {
        if (action === "rename") await renameLiveSession(controller, address, renameValue);
        else if (action === "terminate") await terminateLiveSession(controller, address);
        else if (action === "archive") await archiveLiveSession(controller, address);
        else if (action === "restore") await restoreLiveSession(controller, address);
        else await deleteLiveSession(controller, address);
        // Archive/restore preserves the same draft contract as A to B to A.
        // Only confirmed permanent deletion releases its staged blob URLs.
        if (action === "delete") {
          composerStore.getState().disposeSession(session.id);
        }
        const verb =
          action === "rename"
            ? "renamed"
            : action === "terminate"
              ? "runtime terminated"
              : action === "archive"
                ? "archived"
                : action === "restore"
                  ? "restored"
                  : "permanently deleted";
        onAnnounce(`${session.title} ${verb}.`);
        setMenuOpen(false);
        setDialog(null);
        if (action !== "rename" && action !== "terminate") {
          const navigation = resolveSessionManagementNavigation(
            action,
            session,
            deriveWorkspaceData(controller.getSnapshot()).sessions,
            active,
          );
          workspaceStore.getState().setSessionListView(navigation.view);
          if (navigation.navigate) {
            workspaceStore.getState().setRailOverlayOpen(false);
            if (navigation.destinationSessionId === null) void navigate({ to: "/" });
            else
              void navigate({
                params: { sessionId: navigation.destinationSessionId },
                to: "/sessions/$sessionId",
              });
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session action failed.");
      } finally {
        pendingRef.current = null;
        setPending(null);
      }
    },
    [active, address, controller, navigate, onAnnounce, renameValue, session.id, session.title],
  );

  const menuItem = (
    action: SessionAction,
    label: string,
    icon: ReactNode,
    available: { readonly supported: boolean; readonly reason: string | null },
  ) => (
    <button
      aria-disabled={!available.supported || pending !== null}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
        available.supported && pending === null
          ? "cursor-pointer hover:bg-accent"
          : "cursor-not-allowed text-muted-foreground opacity-64",
        action === "delete" && available.supported && "text-destructive-foreground",
      )}
      onClick={() => {
        if (!available.supported || pending !== null) return;
        if (action === "rename") {
          setRenameValue(session.title);
          setDialog("rename");
          setMenuOpen(false);
        } else if (action === "terminate") {
          setError(null);
          setDialog("terminate");
          setMenuOpen(false);
        } else if (action === "delete") {
          setDeleteValue("");
          setDialog("delete");
          setMenuOpen(false);
        } else void runAction(action);
      }}
      title={available.reason ?? undefined}
      type="button"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{label}</span>
        {!available.supported && available.reason !== null && (
          <span className="text-muted-foreground text-xs leading-snug">{available.reason}</span>
        )}
      </span>
    </button>
  );

  return (
    <div className="flex min-w-0 flex-col" data-session-item={session.id}>
      <div
        className={cn(
          "group/session flex min-w-0 items-stretch rounded-md transition-colors duration-(--motion-duration-fast)",
          active ? "bg-secondary" : "hover:bg-accent",
          session.freshness === "offline" && "opacity-72",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-current={active ? "true" : undefined}
                aria-label={`${session.title}, ${session.model}, ${archived ? "archived, " : ""}${ariaState}${row.unread ? ", unread" : ""}`}
                className="flex min-w-0 flex-1 flex-col gap-0 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                data-session-row={session.id}
                onClick={() => {
                  workspaceStore.getState().setRailOverlayOpen(false);
                  void navigate({
                    params: { sessionId: session.id },
                    to: "/sessions/$sessionId",
                  });
                }}
                tabIndex={index === 0 ? 0 : -1}
                type="button"
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm leading-5">
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
                <span className="flex w-full items-center gap-1 text-[10px] text-muted-foreground leading-4">
                  <span className="shrink-0">{formatRelativeTime(session.updatedAt, nowMs)}</span>
                  <span className="min-w-0 flex-1" />
                  {session.status !== null ? (
                    <StatusPill className="shrink-0 gap-1 text-[10px]" status={session.status} />
                  ) : (
                    stateLabel !== "" && <span className="shrink-0">{stateLabel}</span>
                  )}
                </span>
              </button>
            }
          />
          <TooltipPopup className="max-w-72" side="right">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{session.title}</span>
              <span className="break-all font-mono text-muted-foreground">{session.model}</span>
            </span>
          </TooltipPopup>
        </Tooltip>
        {controller !== null && address !== null && (
          <Popover.Root onOpenChange={setMenuOpen} open={menuOpen}>
            <Popover.Trigger
              aria-label={`Actions for ${session.title}`}
              className="flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:w-8"
              disabled={pending !== null}
            >
              {pending === null ? (
                <MoreHorizontal aria-hidden="true" className="size-4" />
              ) : (
                <Spinner className="size-3.5" />
              )}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
                <Popover.Popup className="max-h-[min(22rem,calc(100dvh-1rem))] w-[min(15rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
                  <Popover.Title className="truncate px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs">
                    {session.title}
                  </Popover.Title>
                  {!archived &&
                    menuItem(
                      "rename",
                      "Rename",
                      <Pencil aria-hidden="true" className="size-4" />,
                      renameSupport,
                    )}
                  {!archived &&
                    menuItem(
                      "terminate",
                      "Terminate runtime",
                      <CircleStop aria-hidden="true" className="size-4" />,
                      terminateSupport,
                    )}
                  {archived
                    ? menuItem(
                        "restore",
                        "Restore",
                        <RotateCcw aria-hidden="true" className="size-4" />,
                        restoreSupport,
                      )
                    : menuItem(
                        "archive",
                        "Archive",
                        <Archive aria-hidden="true" className="size-4" />,
                        archiveSupport,
                      )}
                  {menuItem(
                    "delete",
                    "Permanently delete",
                    <Trash2 aria-hidden="true" className="size-4" />,
                    deleteSupport,
                  )}
                  {workingReason !== null && (
                    <p className="border-border border-t px-2 pt-2 pb-1 text-muted-foreground text-xs">
                      {workingReason}
                    </p>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      {error !== null && (
        <p className="px-2 pt-1 text-destructive-foreground text-xs" role="alert">
          {error}
        </p>
      )}

      <Dialog
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        open={dialog === "rename"}
      >
        <DialogPopup
          aria-label={`Rename ${session.title}`}
          className="max-w-sm"
          showCloseButton={false}
        >
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void runAction("rename");
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-base">Rename session</DialogTitle>
              <DialogDescription>
                Use a short name you will recognize in this working folder.
              </DialogDescription>
              <label className="flex flex-col gap-1 pt-2">
                <span className="font-medium text-muted-foreground text-xs">Session name</span>
                <input
                  autoFocus
                  className="h-11 rounded-lg border border-input bg-input/32 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
                  maxLength={512}
                  onChange={(event) => setRenameValue(event.target.value)}
                  value={renameValue}
                />
              </label>
              {error !== null && (
                <p className="text-destructive-foreground text-xs" role="alert">
                  {error}
                </p>
              )}
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={
                  <Button
                    className="min-h-11 sm:min-h-8"
                    disabled={pending !== null}
                    size="sm"
                    variant="ghost"
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                className="min-h-11 sm:min-h-8"
                disabled={pending !== null || renameValue.trim().length === 0}
                size="sm"
                type="submit"
              >
                {pending === "rename" && <Spinner />}
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        open={dialog === "terminate"}
      >
        <DialogPopup
          aria-label={`Terminate runtime for ${session.title}`}
          className="max-w-md"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-base">
              Terminate runtime for “{session.title}”?
            </DialogTitle>
            <DialogDescription>
              This stops the process handling this session and ends any in-flight turn. The
              transcript, draft, artifacts, and generated output stay intact. Archive or delete only
              after the host reports the runtime closed.
            </DialogDescription>
            {error !== null && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  className="min-h-11 sm:min-h-8"
                  disabled={pending !== null}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              Keep runtime
            </DialogClose>
            <Button
              className="min-h-11 sm:min-h-8"
              disabled={pending !== null}
              onClick={() => void runAction("terminate")}
              size="sm"
              variant="destructive"
            >
              {pending === "terminate" && <Spinner />}
              Terminate runtime
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        open={dialog === "delete"}
      >
        <DialogPopup
          aria-label={`Permanently delete ${session.title}`}
          className="max-w-md"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-base">Permanently delete “{session.title}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes the session, transcript, artifacts, and generated output. It
              cannot be undone.
            </DialogDescription>
            <label className="flex flex-col gap-1 pt-2">
              <span className="font-medium text-muted-foreground text-xs">
                Type the exact session title to confirm
              </span>
              <input
                autoComplete="off"
                autoFocus
                className="h-11 rounded-lg border border-input bg-input/32 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
                onChange={(event) => setDeleteValue(event.target.value)}
                value={deleteValue}
              />
            </label>
            {error !== null && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  className="min-h-11 sm:min-h-8"
                  disabled={pending !== null}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              Keep session
            </DialogClose>
            <Button
              className="min-h-11 sm:min-h-8"
              disabled={pending !== null || deleteValue !== session.title}
              onClick={() => void runAction("delete")}
              size="sm"
              variant="destructive"
            >
              {pending === "delete" && <Spinner />}
              Permanently delete
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function ProjectHeaderRow({
  group,
  allowCreate,
  shortcutHidden,
  onDismiss,
  onRestore,
  view,
}: {
  group: ProjectGroup;
  allowCreate: boolean;
  shortcutHidden: boolean;
  onDismiss: () => void;
  onRestore: () => void;
  view: SessionListView;
}) {
  const navigate = useNavigate();
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disclosureRef = useRef<HTMLButtonElement | null>(null);

  const address = snapshot !== null ? resolveLiveProject(snapshot, group.project.id) : null;
  const createTargets =
    snapshot === null
      ? []
      : resolveLiveProjectCreateTargets(snapshot, group.project.id).filter(
          (target) => sessionCreateSupport(snapshot, target.address).supported,
        );
  const createSupport =
    createTargets.length > 0
      ? { supported: true, reason: null }
      : address !== null && snapshot !== null
        ? sessionCreateSupport(snapshot, address)
        : { supported: false, reason: "Connect to this host to create a session" };
  const projectIsLocal =
    snapshot !== null &&
    address !== null &&
    snapshot.targets.get(address.targetId)?.kind === "local";
  const configuredLocalProfiles =
    projectIsLocal && snapshot !== null
      ? [...snapshot.targets.values()].filter((target) => target.kind === "local")
      : [];
  // Every configured local profile that cannot create here right now is still
  // shown, with why: disconnected profiles say so, connected-but-unsupported
  // profiles surface the host's reason.
  const unavailableLocalProfiles =
    snapshot === null || address === null
      ? []
      : configuredLocalProfiles
          .filter(
            (profile) =>
              !createTargets.some((target) => target.address.targetId === profile.targetId),
          )
          .map((profile) => {
            if (snapshot.connections.get(profile.targetId) !== "connected") {
              return { label: profile.label, reason: "Not connected", targetId: profile.targetId };
            }
            const hostId = snapshot.targetHosts.get(profile.targetId);
            const support =
              hostId === undefined
                ? null
                : sessionCreateSupport(snapshot, {
                    hostId,
                    projectId: address.projectId,
                    targetId: profile.targetId,
                  });
            return {
              label: profile.label,
              reason: support?.reason ?? "Unavailable",
              targetId: profile.targetId,
            };
          });
  const canCreate = allowCreate && createTargets.length > 0 && controller !== null && !pending;
  // Never fall back to an opaque direct create while other configured profiles
  // exist or nothing can create: the chooser stays, listing each configured
  // profile as available or unavailable and linking host management.
  const chooseCreateProfile =
    requiresProfileChoiceForCreate(createTargets) ||
    configuredLocalProfiles.length > 1 ||
    (projectIsLocal && createTargets.length === 0);
  // The chooser opens whenever it has something to show — even when no target
  // can create right now, it explains why and links host management. Only the
  // per-profile create rows are gated on a live connection.
  const createMenuAvailable =
    allowCreate && !pending && (canCreate || configuredLocalProfiles.length > 0);
  const emptyCurrentProject = view === "current" && group.sessions.length === 0;
  const inventoryTruncated = group.host.sessionInventoryTruncated === true;
  const showProjectMenu = emptyCurrentProject || (view === "archived" && shortcutHidden);

  const handleCreate = useCallback(
    async (targetAddress: NonNullable<typeof address>) => {
      if (!canCreate || controller === null) return;
      setPending(true);
      setError(null);
      try {
        const result = await createLiveSession(controller, targetAddress);
        setCreateMenuOpen(false);
        workspaceStore.getState().setRailOverlayOpen(false);
        void navigate({ params: { sessionId: result.viewId }, to: "/sessions/$sessionId" });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session creation failed.");
      } finally {
        setPending(false);
      }
    },
    [canCreate, controller, navigate],
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-expanded={group.expanded}
                aria-label={`${group.project.name}, ${group.sessions.length} ${group.sessions.length === 1 ? "session" : "sessions"}${group.unreadCount > 0 ? `, ${group.unreadCount} unread` : ""}`}
                className="flex min-h-11 min-w-0 flex-1 items-start gap-1 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-0"
                data-project-disclosure={group.project.id}
                onClick={() =>
                  workspaceStore.getState().setProjectExpanded(group.project.id, !group.expanded)
                }
                ref={disclosureRef}
                type="button"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)",
                    group.expanded && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 break-words font-medium text-foreground text-xs leading-4">
                  {group.project.name}
                </span>
                {!group.expanded && group.unreadCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="mt-1 size-1.5 shrink-0 rounded-full bg-brand"
                  />
                )}
                {!group.expanded && group.groupStatus !== null && (
                  <StatusPill className="mt-1" labelHidden status={group.groupStatus} />
                )}
                <span className="mt-px shrink-0 text-[10px] text-muted-foreground leading-4">
                  {group.sessions.length}
                </span>
              </button>
            }
          />
          <TooltipPopup className="max-w-72" side="right">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{group.project.name}</span>
              <span className="break-all text-muted-foreground">
                {group.host.kind === "remote" ? "Remote host" : "Host profile"}: {group.host.name}
              </span>
            </span>
          </TooltipPopup>
        </Tooltip>
        {allowCreate && chooseCreateProfile ? (
          <Popover.Root onOpenChange={setCreateMenuOpen} open={createMenuOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Popover.Trigger
                    aria-label={`New session in ${group.project.name} — choose the OMP profile that will own it`}
                    className="flex h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-medium text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:px-1.5"
                    disabled={!createMenuAvailable}
                  >
                    {pending ? (
                      <Spinner className="size-3" />
                    ) : (
                      <Plus aria-hidden="true" className="size-3" />
                    )}
                    New
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </Popover.Trigger>
                }
              />
              <TooltipPopup side="right">Choose the OMP profile for a new session</TooltipPopup>
            </Tooltip>
            <Popover.Portal>
              <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
                <Popover.Popup className="w-[min(15rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
                  <Popover.Title className="truncate px-2 pt-1 font-medium text-xs">
                    New session in {group.project.name}
                  </Popover.Title>
                  <Popover.Description className="px-2 pb-1.5 text-muted-foreground text-xs leading-snug">
                    The OMP profile you choose will own this session.
                  </Popover.Description>
                  {createTargets.map((target) => (
                    <button
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      disabled={pending}
                      key={target.address.targetId}
                      onClick={() => void handleCreate(target.address)}
                      type="button"
                    >
                      <UsersRound
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate text-sm">{target.label}</span>
                        {target.profileId !== undefined && (
                          <span className="truncate font-mono text-muted-foreground text-[11px]">
                            {target.profileId}
                          </span>
                        )}
                      </span>
                      {target.current && <Badge variant="outline">Current</Badge>}
                    </button>
                  ))}
                  {createTargets.length === 0 && (
                    <p className="px-2 py-1.5 text-muted-foreground text-xs leading-snug">
                      No connected profile can start a session here yet.
                    </p>
                  )}
                  {unavailableLocalProfiles.map((profile) => (
                    <div
                      aria-disabled="true"
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left opacity-64 sm:min-h-8"
                      key={profile.targetId}
                    >
                      <UsersRound
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate text-sm">{profile.label}</span>
                        <span className="truncate text-muted-foreground text-[11px]">
                          {profile.reason}
                        </span>
                      </span>
                    </div>
                  ))}
                  {(unavailableLocalProfiles.length > 0 || createTargets.length === 0) && (
                    <button
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        workspaceStore.getState().setRailOverlayOpen(false);
                        void navigate({ to: "/hosts" });
                      }}
                      type="button"
                    >
                      <Cable aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate text-sm">Open Hosts</span>
                        <span className="truncate text-muted-foreground text-[11px]">
                          Connect a profile to use it here
                        </span>
                      </span>
                    </button>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : allowCreate ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-disabled={!canCreate}
                  aria-label={`New session in ${group.project.name}`}
                  className={cn(
                    "flex h-11 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:px-1.5",
                    canCreate
                      ? "cursor-pointer hover:bg-accent hover:text-foreground"
                      : "cursor-not-allowed opacity-64",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!canCreate) return;
                    const target = createTargets[0];
                    if (target !== undefined) void handleCreate(target.address);
                  }}
                  title={createSupport.reason ?? undefined}
                  type="button"
                >
                  {pending ? (
                    <Spinner className="size-3" />
                  ) : (
                    <Plus aria-hidden="true" className="size-3" />
                  )}
                  New
                </button>
              }
            />
            <TooltipPopup side="right">
              {createSupport.reason ?? `New session in ${group.project.name}`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {showProjectMenu && (
          <Popover.Root onOpenChange={setMenuOpen} open={menuOpen}>
            <Popover.Trigger
              aria-label={`Actions for ${group.project.name}`}
              className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:size-6"
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
                <Popover.Popup className="max-h-[min(22rem,calc(100dvh-1rem))] w-[min(17rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
                  <Popover.Title className="truncate px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs">
                    {group.project.name}
                  </Popover.Title>
                  {emptyCurrentProject ? (
                    <button
                      aria-disabled={inventoryTruncated || pending || undefined}
                      className={cn(
                        "flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                        inventoryTruncated || pending
                          ? "cursor-not-allowed text-muted-foreground opacity-64"
                          : "cursor-pointer hover:bg-accent",
                      )}
                      onClick={() => {
                        if (inventoryTruncated || pending) return;
                        setMenuOpen(false);
                        onDismiss();
                      }}
                      type="button"
                    >
                      <X aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm">Remove shortcut</span>
                        <span className="block text-muted-foreground text-xs leading-snug">
                          {inventoryTruncated
                            ? "This host is showing a partial session list, so this shortcut can't be removed safely."
                            : "Only changes this T4 Code client. The folder and OMP sessions stay unchanged."}
                        </span>
                      </span>
                    </button>
                  ) : (
                    <button
                      className="flex min-h-11 w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      onClick={() => {
                        setMenuOpen(false);
                        onRestore();
                        requestAnimationFrame(() => disclosureRef.current?.focus());
                      }}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm">Show shortcut</span>
                        <span className="block text-muted-foreground text-xs leading-snug">
                          Makes the empty folder shortcut available in this client again.
                        </span>
                      </span>
                    </button>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
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

export function Rail({
  groups,
  hiddenEmptyProjectIds,
  nowMs,
  view,
  currentCount,
  archivedCount,
  attentionCount,
}: {
  groups: readonly ProjectGroup[];
  hiddenEmptyProjectIds: ReadonlySet<string>;
  nowMs: number;
  view: SessionListView;
  currentCount: number;
  archivedCount: number;
  attentionCount: number;
}) {
  const navigate = useNavigate();
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const [announcement, setAnnouncement] = useState("");
  const navRef = useRef<HTMLElement | null>(null);

  const dismissProject = (group: ProjectGroup) => {
    const disclosures = [
      ...(navRef.current?.querySelectorAll<HTMLElement>("[data-project-disclosure]") ?? []),
    ];
    const currentIndex = disclosures.findIndex(
      (element) => element.dataset.projectDisclosure === group.project.id,
    );
    const focusTarget =
      disclosures[currentIndex + 1] ?? disclosures[currentIndex - 1] ?? navRef.current;
    workspaceStore.getState().setEmptyProjectDismissed(group.project.id, true);
    setAnnouncement(
      `Removed ${group.project.name} from Working folders. The folder and OMP sessions are unchanged.`,
    );
    requestAnimationFrame(() => {
      const target = focusTarget?.isConnected ? focusTarget : navRef.current;
      target?.focus();
    });
  };

  let rowIndex = 0;
  return (
    <nav
      aria-label="Working folders and sessions"
      className="flex h-full min-h-0 flex-col overflow-y-auto px-1.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDown={handleRailKeyDown}
      ref={navRef}
      tabIndex={-1}
    >
      <div className="px-1.5 pb-1.5">
        <div className="flex h-7 items-center">
          <h2 className="font-medium text-foreground text-xs">Sessions</h2>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">⌘K</span>
        </div>
        <button
          className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
          onClick={() => {
            workspaceStore.getState().setRailOverlayOpen(false);
            void navigate({ to: "/inbox" });
          }}
          type="button"
        >
          <Inbox aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">Attention</span>
          {attentionCount > 0 && (
            <Badge aria-label={`${attentionCount} items need attention`} variant="secondary">
              {attentionCount}
            </Badge>
          )}
        </button>
        <SessionListTabs archivedCount={archivedCount} currentCount={currentCount} view={view} />
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {(view === "current" ? currentCount === 0 : archivedCount === 0) && (
        <p className="px-2 py-5 text-center text-muted-foreground text-sm">
          {view === "archived" ? "No archived sessions." : "No current sessions."}
        </p>
      )}
      {groups.map((group) => (
        <section
          aria-label={group.project.name}
          className="mb-1"
          data-project-id={group.project.id}
          key={group.project.id}
        >
          <ProjectHeaderRow
            allowCreate={view === "current"}
            group={group}
            onDismiss={() => dismissProject(group)}
            onRestore={() => {
              workspaceStore.getState().setEmptyProjectDismissed(group.project.id, false);
              setAnnouncement(
                `Restored ${group.project.name} to Working folders on this T4 Code client.`,
              );
            }}
            shortcutHidden={hiddenEmptyProjectIds.has(group.project.id)}
            view={view}
          />
          {group.expanded && (
            <div className="mt-0.5 flex flex-col gap-px">
              {group.sessions.map((row) => (
                <SessionRowItem
                  active={row.session.id === activeSessionId}
                  index={rowIndex++}
                  key={row.session.id}
                  nowMs={nowMs}
                  onAnnounce={setAnnouncement}
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

export { CollapsedRail } from "./CollapsedRail.tsx";
