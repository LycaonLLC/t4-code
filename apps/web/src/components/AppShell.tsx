// Shell frame: titlebar, resizable project/session rail (docked, collapsed
// strip, or narrow-width overlay), the routed center, and the command
// palette. Keyboard: Cmd/Ctrl+K palette, Cmd/Ctrl+B rail, Cmd/Ctrl+1..9
// visible sessions, Escape peels the topmost open surface.
import { Button, Sheet, SheetClose, SheetPopup, SheetTitle } from "@t4-code/ui";
import { deriveAttentionInbox } from "@t4-code/client";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  startDesktopRuntime,
  useDesktopRuntimeSnapshot,
} from "../platform/desktop-runtime.ts";
import {
  ATTENTION_INBOX_FIXTURES,
  buildAttentionInboxViewModel,
} from "../features/attention/index.ts";
import { getShellData, useShellData } from "../state/shell-data.ts";
import { RAIL_OVERLAY_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import { isEditableTarget, resolveShortcut } from "../keyboard/shortcuts.ts";
import { buildProjectGroups, listVisibleSessionIds } from "../lib/session-tree.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
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
  const sessionListView = useWorkspace((state) => state.sessionListView);
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
      ),
    [shellData, projectExpandedById, lastVisitedAtBySessionId, dismissedEmptyProjectIds],
  );
  const archivedGroups = useMemo(
    () => buildProjectGroups(shellData, projectExpandedById, lastVisitedAtBySessionId, "archived"),
    [shellData, projectExpandedById, lastVisitedAtBySessionId],
  );
  const groups = sessionListView === "archived" ? archivedGroups : currentGroups;
  const currentCount = shellData.sessions.filter((session) => session.archivedAt === undefined).length;
  const archivedCount = shellData.sessions.length - currentCount;
  const attentionCount = useMemo(
    () =>
      runtimeSnapshot === null
        ? buildAttentionInboxViewModel(ATTENTION_INBOX_FIXTURES.mixed.items).urgentCount
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
        if (state.paletteOpen || state.railOverlayOpen) return;
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
        if (railOverlaid) state.setRailOverlayOpen(!state.railOverlayOpen);
        else state.setRailCollapsed(!state.railCollapsed);
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
    collapsed: railCollapsed,
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden bg-background text-foreground">
      <Titlebar
        onToggleRail={() => {
          const state = workspaceStore.getState();
          if (railOverlaid) state.setRailOverlayOpen(!state.railOverlayOpen);
          else state.setRailCollapsed(!state.railCollapsed);
        }}
        railToggle={railToggle}
      />
      <div className="flex min-h-0 flex-1">
        {!railOverlaid && (
          <>
            <div
              className="rail-dock flex h-full shrink-0 flex-col overflow-hidden bg-background"
              style={{ width: railCollapsed ? RAIL_COLLAPSED_WIDTH : effectiveRailWidth }}
            >
              {railCollapsed ? (
                <div className="h-full" style={{ width: RAIL_COLLAPSED_WIDTH }}>
                  <CollapsedRail
                    attentionCount={attentionCount}
                    groups={currentGroups}
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
                    attentionCount={attentionCount}
                    archivedCount={archivedCount}
                    currentCount={currentCount}
                    groups={groups}
                    hiddenEmptyProjectIds={hiddenEmptyProjectIds}
                    nowMs={nowMs}
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
          open={railOverlayOpen}
        >
          <SheetPopup
            aria-label="Working folders and sessions"
            className="w-[min(20rem,calc(100vw-1rem))] p-0"
            showCloseButton={false}
            side="left"
          >
            <div className="flex h-14 shrink-0 items-center border-border border-b px-3">
              <SheetTitle className="text-sm">
                <span aria-hidden="true">Sessions</span>
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
                attentionCount={attentionCount}
                archivedCount={archivedCount}
                currentCount={currentCount}
                groups={groups}
                hiddenEmptyProjectIds={hiddenEmptyProjectIds}
                nowMs={nowMs}
                view={sessionListView}
              />
            </div>
          </SheetPopup>
        </Sheet>
      )}

      <CommandPalette groups={currentGroups} />
    </div>
  );
}
