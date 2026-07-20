// Boots the one live workspace store for this window: resolve the renderer
// platform, apply fixture boot switches (browser mode only), seed
// first-visit timestamps, and apply the theme and accent before the first
// paint. Workspace view state persists locally in both modes; the desktop
// shell port carries runtime truth, never UI persistence.
import { useStore } from "zustand";

import { parseFixtureBootOptions } from "../fixture/boot.ts";
import { SHELL_FIXTURE } from "../fixture/data.ts";
import { resolveRendererPlatform, type RendererPlatform } from "../platform/bridge.ts";
import { applyAccent, loadAccent } from "../theme/accent.ts";
import { applyTheme, watchSystemTheme } from "../theme/theme.ts";
import {
  createWorkspaceStore,
  markVisited,
  PANE_FAMILIES,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceState,
  type WorkspaceStore,
  type WorkspaceStoreApi,
} from "./workspace-store.ts";

const bootOptions = parseFixtureBootOptions(
  typeof window === "undefined" ? "" : window.location.search,
);

const demoMode = import.meta.env.MODE === "demo";

export const rendererPlatform: RendererPlatform = resolveRendererPlatform(
  bootOptions.platform ?? undefined,
  { forceFixture: demoMode },
);

const browserMode = rendererPlatform.mode === "browser";

if (browserMode && bootOptions.reset && typeof window !== "undefined") {
  try {
    window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // Nothing persisted to reset.
  }
}

function buildBootOverrides(): Partial<WorkspaceState> {
  if (!browserMode) return {};
  return {
    ...(bootOptions.theme !== null && { theme: bootOptions.theme }),
    ...(bootOptions.railCollapsed && { railCollapsed: true }),
    ...(bootOptions.session !== null && { activeSessionId: bootOptions.session }),
  };
}

// The reset switch already cleared storage above, so plain persistence reads
// back nothing on a reset boot.
export const workspaceStore: WorkspaceStoreApi = createWorkspaceStore({
  persistence: rendererPlatform.persistence,
  overrides: buildBootOverrides(),
});

// Fixture timestamps regenerate on every load, so first-visit seeds are
// overlaid each boot; genuinely newer persisted visits win (monotonic).
// Browser mode only — the desktop shell never reads fixture data.
if (browserMode) {
  const state = workspaceStore.getState();
  let visited = { ...SHELL_FIXTURE.seedLastVisitedAt };
  for (const [sessionId, visitedAt] of Object.entries(state.lastVisitedAtBySessionId)) {
    visited = markVisited(visited, sessionId, visitedAt);
  }
  workspaceStore.setState({ lastVisitedAtBySessionId: visited });

  const paneFamily = PANE_FAMILIES.find((family) => family === bootOptions.pane);
  const activeId = state.activeSessionId;
  if (activeId !== null) {
    if (paneFamily !== undefined) {
      workspaceStore.getState().togglePaneFamily(activeId, paneFamily);
      workspaceStore.getState().setPaneOpen(activeId, true);
    }
    if (bootOptions.terminalDrawer) {
      workspaceStore.getState().setTerminalDrawerOpen(activeId, true);
    }
  }
}

// Apply before the first render so there is no theme or accent flash, then
// track the OS scheme while the preference is "system".
applyTheme(workspaceStore.getState().theme);
applyAccent(loadAccent());
watchSystemTheme(() => workspaceStore.getState().theme);
workspaceStore.subscribe((state, previous) => {
  if (state.theme !== previous.theme) applyTheme(state.theme, true);
});

if (typeof document !== "undefined") {
  document.documentElement.dataset.platform = rendererPlatform.platform;
}

export function useWorkspace<T>(selector: (state: WorkspaceStore) => T): T {
  return useStore(workspaceStore, selector);
}
