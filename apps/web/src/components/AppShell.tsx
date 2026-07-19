// Shell frame: titlebar, resizable project/session rail (docked, collapsed
// strip, or narrow-width overlay), the routed center, and the command
// palette. Keyboard: Cmd/Ctrl+K palette, Cmd/Ctrl+B rail, Cmd/Ctrl+1..9
// visible sessions, Escape peels the topmost open surface.
import { Button, Sheet, SheetClose, SheetPopup, SheetTitle } from "@t4-code/ui";
import { deriveAttentionInbox } from "@t4-code/client";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { startDesktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import {
  ATTENTION_INBOX_FIXTURES,
  buildAttentionInboxViewModel,
} from "../features/attention/index.ts";
import { getShellData, useShellData } from "../state/shell-data.ts";
import { RAIL_OVERLAY_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import { isEditableTarget, resolveShortcut } from "../keyboard/shortcuts.ts";
import { buildProjectGroups, listVisibleSessionIds } from "../lib/session-tree.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { RAIL_COLLAPSED_WIDTH, RAIL_WIDTH, selectSessionView } from "../state/workspace-store.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { CollapsedRail, Rail } from "./Rail.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { Titlebar } from "./Titlebar.tsx";
import { resolveRailTogglePresentation } from "./rail-toggle.ts";

export function AppShell() {
  const navigate = useNavigate();
  const railOverlaid = useMediaQuery(RAIL_OVERLAY_QUERY);
  const railCollapsed = useWorkspace((state) => state.railCollapsed);
  const railWidth = useWorkspace((state) => state.railWidth);
  const railOverlayOpen = useWorkspace((state) => state.railOverlayOpen);
  const focusMode = useWorkspace((state) => state.focusMode);
  const sessionListView = useWorkspace((state) => state.sessionListView);
  const railSort = useWorkspace((state) => state.railSort);
  const railQuery = useWorkspace((state) => state.railQuery);
  const railFilter = useWorkspace((state) => state.railFilter);
  const projectManualOrder = useWorkspace((state) => state.projectManualOrder);
  const sessionManualOrderByProjectId = useWorkspace(
    (state) => state.sessionManualOrderByProjectId,
  );
  const projectExpandedById = useWorkspace((state) => state.projectExpandedById);
  const dismissedEmptyProjectIds = useWorkspace((state) => state.dismissedEmptyProjectIds);
  const lastVisitedAtBySessionId = useWorkspace((state) => state.lastVisitedAtBySessionId);
  const lastSeenAttentionOutcomeBySessionKey = useWorkspace(
    (state) => state.lastSeenAttentionOutcomeBySessionKey,
  );
  const [railPreviewWidth, setRailPreviewWidth] = useState<number | null>(null);
  const [nowMs] = useState(() => Date.now());

  const shellData = useShellData();
  const runtimeSnapshot = useDesktopRuntimeSnapshot();
  const currentGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "current",
        dismissedEmptyProjectIds,
        {
          filter: railFilter,
          query: railQuery,
          sort: railSort,
          projectManualOrder,
          sessionManualOrderByProjectId,
        },
      ),
    [
      shellData,
      projectExpandedById,
      lastVisitedAtBySessionId,
      dismissedEmptyProjectIds,
      railFilter,
      railQuery,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
    ],
  );
  const archivedGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "archived",
        {},
        {
          filter: railFilter,
          query: railQuery,
          sort: railSort,
          projectManualOrder,
          sessionManualOrderByProjectId,
        },
      ),
    [
      shellData,
      projectExpandedById,
      lastVisitedAtBySessionId,
      railFilter,
      railQuery,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
    ],
  );
  const allCurrentGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "current",
        dismissedEmptyProjectIds,
        { sort: railSort, projectManualOrder, sessionManualOrderByProjectId },
      ),
    [
      shellData,
      projectExpandedById,
      lastVisitedAtBySessionId,
      dismissedEmptyProjectIds,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
    ],
  );
  const allArchivedGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "archived",
        {},
        { sort: railSort, projectManualOrder, sessionManualOrderByProjectId },
      ),
    [
      shellData,
      projectExpandedById,
      lastVisitedAtBySessionId,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
    ],
  );
  const allSessionGroups = useMemo(
    () => [...allCurrentGroups, ...allArchivedGroups],
    [allArchivedGroups, allCurrentGroups],
  );
  const groups = sessionListView === "archived" ? archivedGroups : currentGroups;
  const currentCount = shellData.sessions.filter(
    (session) => session.archivedAt === undefined,
  ).length;
  const archivedCount = shellData.sessions.length - currentCount;
  const attentionCount = useMemo(
    () =>
      runtimeSnapshot === null
        ? buildAttentionInboxViewModel(ATTENTION_INBOX_FIXTURES.sample.items).urgentCount
        : deriveAttentionInbox(runtimeSnapshot, {
            seenOutcomeIdsBySessionKey: lastSeenAttentionOutcomeBySessionKey,
          }).urgentCount,
    [lastSeenAttentionOutcomeBySessionKey, runtimeSnapshot],
  );
  const hiddenEmptyProjectIds = useMemo(() => {
    const currentProjectIds = new Set(
      shellData.sessions
        .filter((session) => session.archivedAt === undefined)
        .map((session) => session.projectId),
    );
    const hostById = new Map(shellData.hosts.map((host) => [host.id, host]));
    return new Set(
      shellData.projects
        .filter(
          (project) =>
            dismissedEmptyProjectIds[project.id] === true &&
            !currentProjectIds.has(project.id) &&
            hostById.get(project.hostId)?.sessionInventoryTruncated !== true,
        )
        .map((project) => project.id),
    );
  }, [dismissedEmptyProjectIds, shellData]);

  // Desktop mode: start the runtime once. StrictMode's doubled effect and
  // HMR remounts are safe — start is idempotent on a global singleton.
  useEffect(() => {
    startDesktopRuntime();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        // Dialog-based surfaces (palette, sheets) close themselves; the
        // docked pane is plain layout, so Escape peels it here.
        const state = workspaceStore.getState();
        if (state.paletteOpen || (state.railOverlayOpen && !state.focusMode)) return;
        if (state.focusMode) {
          state.setFocusMode(false);
          event.preventDefault();
          return;
        }
        const activeId = state.activeSessionId;
        if (activeId !== null && selectSessionView(state, activeId).paneOpen) {
          state.setPaneOpen(activeId, false);
          event.preventDefault();
        }
        return;
      }

      const action = resolveShortcut(event);
      if (action === null) return;
      if (isEditableTarget(event.target) && action.kind === "session-index") return;
      event.preventDefault();

      const state = workspaceStore.getState();
      if (action.kind === "palette") {
        state.setPaletteOpen(!state.paletteOpen);
      } else if (action.kind === "toggle-rail") {
        if (state.focusMode) {
          state.setFocusMode(false);
          state.setRailCollapsed(false);
        } else if (railOverlaid) state.setRailOverlayOpen(!state.railOverlayOpen);
        else state.setRailCollapsed(!state.railCollapsed);
      } else if (action.kind === "toggle-terminal") {
        const activeId = state.activeSessionId;
        const activeSession =
          activeId === null
            ? undefined
            : getShellData().sessions.find((session) => session.id === activeId);
        if (activeId !== null && activeSession?.archivedAt === undefined) {
          const view = selectSessionView(state, activeId);
          if (state.focusMode) {
            state.setFocusMode(false);
            state.setTerminalDrawerOpen(activeId, true);
          } else {
            state.setTerminalDrawerOpen(activeId, !view.terminalDrawerOpen);
          }
        }
      } else if (action.kind === "toggle-focus") {
        state.setFocusMode(!state.focusMode);
      } else if (action.kind === "settings") {
        void navigate({ to: "/settings" });
      } else {
        const visible = listVisibleSessionIds(
          buildProjectGroups(
            getShellData(),
            state.projectExpandedById,
            state.lastVisitedAtBySessionId,
            state.sessionListView,
            state.dismissedEmptyProjectIds,
            {
              filter: state.railFilter,
              query: state.railQuery,
              sort: state.railSort,
              projectManualOrder: state.projectManualOrder,
              sessionManualOrderByProjectId: state.sessionManualOrderByProjectId,
            },
          ),
        );
        const sessionId = visible[action.index];
        if (sessionId !== undefined) {
          void navigate({ params: { sessionId }, to: "/sessions/$sessionId" });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, railOverlaid]);

  // Rail collapse/expand animates width via .rail-dock; the center column
  // reflows with it and keeps its own focus and scroll.
  const effectiveRailWidth = railPreviewWidth ?? railWidth;
  const railToggle = resolveRailTogglePresentation({
    overlaid: railOverlaid,
    overlayOpen: railOverlayOpen,
    collapsed: railCollapsed || focusMode,
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden bg-background text-foreground">
      <Titlebar
        focusMode={focusMode}
        onExitFocus={() => workspaceStore.getState().setFocusMode(false)}
        onToggleRail={() => {
          const state = workspaceStore.getState();
          if (state.focusMode) {
            state.setFocusMode(false);
            state.setRailCollapsed(false);
          } else if (railOverlaid) state.setRailOverlayOpen(!state.railOverlayOpen);
          else state.setRailCollapsed(!state.railCollapsed);
        }}
        railToggle={railToggle}
      />
      {rendererPlatform.demo && (
        <div
          aria-label="Sample data notice"
          className="flex min-h-7 shrink-0 items-center justify-center gap-1.5 border-border/60 border-b bg-primary/8 px-2 text-center text-xs"
        >
          <span className="font-semibold text-primary">Sample data</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span className="truncate text-muted-foreground">
            Explore freely. No live hosts, accounts, or files are connected.
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {!railOverlaid && !focusMode && (
          <>
            <div
              className="rail-dock flex h-full shrink-0 flex-col overflow-hidden border-border/60 border-r bg-(--sidebar-background)"
              style={{ width: railCollapsed ? RAIL_COLLAPSED_WIDTH : effectiveRailWidth }}
            >
              {railCollapsed ? (
                <div className="h-full" style={{ width: RAIL_COLLAPSED_WIDTH }}>
                  <CollapsedRail
                    attentionCount={attentionCount}
                    groups={allCurrentGroups}
                    onExpand={(projectId) => {
                      const state = workspaceStore.getState();
                      state.setRailCollapsed(false);
                      state.setProjectExpanded(projectId, true);
                    }}
                  />
                </div>
              ) : (
                <div className="flex h-full flex-col" style={{ width: effectiveRailWidth }}>
                  <Rail
                    allGroups={allCurrentGroups}
                    attentionCount={attentionCount}
                    archivedCount={archivedCount}
                    currentCount={currentCount}
                    groups={groups}
                    hiddenEmptyProjectIds={hiddenEmptyProjectIds}
                    nowMs={nowMs}
                    pinnedSessionGroups={allSessionGroups}
                    view={sessionListView}
                  />
                </div>
              )}
            </div>
            {!railCollapsed && (
              <ResizeHandle
                bounds={RAIL_WIDTH}
                edge="right"
                label="Resize session list"
                onCommit={(width) => workspaceStore.getState().setRailWidth(width)}
                onPreview={setRailPreviewWidth}
                width={effectiveRailWidth}
              />
            )}
          </>
        )}
        <main className="flex min-h-0 min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {railOverlaid && (
        <Sheet
          onOpenChange={(open) => workspaceStore.getState().setRailOverlayOpen(open)}
          open={railOverlayOpen && !focusMode}
        >
          <SheetPopup
            aria-label="Working folders and sessions"
            className="w-[min(20rem,calc(100vw-1rem))] p-0"
            showCloseButton={false}
            side="left"
          >
            <div className="flex h-14 shrink-0 items-center border-border border-b px-3">
              <SheetTitle className="text-sm">
                <span aria-hidden="true">T4 Code</span>
                <span className="sr-only">Working folders and sessions</span>
              </SheetTitle>
              <SheetClose
                aria-label="Close"
                className="ml-auto size-11"
                render={<Button size="icon" variant="ghost" />}
              >
                <X aria-hidden="true" className="size-4" />
              </SheetClose>
            </div>
            <div className="min-h-0 flex-1">
              <Rail
                allGroups={allCurrentGroups}
                attentionCount={attentionCount}
                archivedCount={archivedCount}
                currentCount={currentCount}
                groups={groups}
                hiddenEmptyProjectIds={hiddenEmptyProjectIds}
                nowMs={nowMs}
                pinnedSessionGroups={allSessionGroups}
                view={sessionListView}
              />
            </div>
          </SheetPopup>
        </Sheet>
      )}

      <CommandPalette groups={allCurrentGroups} />
    </div>
  );
}
