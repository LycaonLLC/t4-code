// Versioned workspace store: everything the shell remembers about layout and
// navigation. Visited/unread and persistence sanitizing adapted from T3 Code
// apps/web/src/uiStateStore.ts; per-session pane continuity adapted from T3
// Code apps/web/src/rightPanelStore.ts (both MIT, T3 Tools Inc., commit
// f61fa9499d96fee825492aba204593c37b27e0cb). OMP changes: one store behind a
// pluggable persistence adapter, five fixed pane families, no cloud state.
// This is renderer view state only — never runtime authority.
import { clampWidth } from "@t4-code/ui";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { SessionListView } from "../lib/workspace-data.ts";
import type { WorkspacePersistence } from "./persistence.ts";

export const WORKSPACE_STATE_VERSION = 2;
export const WORKSPACE_STORAGE_KEY = "omp:workspace:v1";

export const RAIL_WIDTH = { minWidth: 208, maxWidth: 400, defaultWidth: 256 } as const;
export const RAIL_COLLAPSED_WIDTH = 48;
export const RIGHT_PANE_WIDTH = { minWidth: 320, maxWidth: 560, defaultWidth: 448 } as const;

export const PANE_FAMILIES = ["agents", "activity", "review", "files", "terminals"] as const;
export type PaneFamily = (typeof PANE_FAMILIES)[number];

export type ThemePreference = "light" | "dark" | "system";
export type PreviewScaleMode = "fit" | "actual";

export interface SessionPreviewSelection {
  readonly previewId: string | null;
  readonly optInKind?: string | null;
  readonly optInAuthorityId?: string | null;
  readonly optIn: boolean;
}

/** Per-session view continuity: everything restored on A→B→A switching. */
export interface SessionViewState {
  /** Transcript scroll offset; null follows the tail. */
  readonly scrollTop: number | null;
  /** Composer draft (composer itself is a later lane; continuity lives here). */
  readonly draft: string;
  readonly paneFamily: PaneFamily;
  readonly paneOpen: boolean;
  readonly paneWidth: number;
  readonly terminalDrawerOpen: boolean;
  /** Preview tab and scale restored on A→B→A route switching. */
  readonly previewId: string | null;
  readonly previewOptIn: boolean;
  readonly previewOptInKind: string | null;
  readonly previewOptInAuthorityId: string | null;
  readonly previewScale: PreviewScaleMode;
}

export const DEFAULT_SESSION_VIEW: SessionViewState = {
  scrollTop: null,
  draft: "",
  paneFamily: "agents",
  paneOpen: false,
  paneWidth: RIGHT_PANE_WIDTH.defaultWidth,
  terminalDrawerOpen: false,
  previewId: null,
  previewOptIn: false,
  previewOptInKind: null,
  previewOptInAuthorityId: null,
  previewScale: "fit",
};

interface PersistedWorkspaceState {
  readonly version: number;
  readonly theme: ThemePreference;
  readonly railWidth: number;
  readonly railCollapsed: boolean;
  readonly sessionListView?: SessionListView;
  readonly activeSessionId: string | null;
  readonly projectExpandedById: Record<string, boolean>;
  /** Empty Current-tab project headers the user explicitly removed. */
  readonly dismissedEmptyProjectIds?: Record<string, true>;
  readonly lastVisitedAtBySessionId: Record<string, string>;
  /** Latest terminal attention outcome the user has seen for each session. */
  readonly lastSeenAttentionOutcomeBySessionKey?: Record<string, string>;
  readonly sessionViewById: Record<string, SessionViewState>;
}

export interface WorkspaceState {
  readonly theme: ThemePreference;
  readonly railWidth: number;
  readonly railCollapsed: boolean;
  readonly sessionListView: SessionListView;
  /** Narrow-width overlay rail; ephemeral, never persisted. */
  readonly railOverlayOpen: boolean;
  /** Command palette visibility; ephemeral, never persisted. */
  readonly paletteOpen: boolean;
  readonly activeSessionId: string | null;
  readonly projectExpandedById: Record<string, boolean>;
  /** View-only dismissals; a current session makes its project visible again. */
  readonly dismissedEmptyProjectIds: Record<string, true>;
  readonly lastVisitedAtBySessionId: Record<string, string>;
  /** Renderer-local read markers; OMP remains the outcome authority. */
  readonly lastSeenAttentionOutcomeBySessionKey: Record<string, string>;
  readonly sessionViewById: Record<string, SessionViewState>;
}

export interface WorkspaceActions {
  setTheme(theme: ThemePreference): void;
  setRailWidth(width: number): void;
  setRailCollapsed(collapsed: boolean): void;
  setSessionListView(view: SessionListView): void;
  setRailOverlayOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;
  /** Make a session active and stamp it visited. */
  activateSession(sessionId: string, visitedAt: string): void;
  /** Stamp a visit; timestamps only move forward. */
  markSessionVisited(sessionId: string, visitedAt: string): void;
  /** Mark one host-authored terminal outcome as seen on this client. */
  markAttentionOutcomeSeen(sessionKey: string, outcomeId: string): void;
  setProjectExpanded(projectId: string, expanded: boolean): void;
  setEmptyProjectDismissed(projectId: string, dismissed: boolean): void;
  setSessionDraft(sessionId: string, draft: string): void;
  setSessionScrollTop(sessionId: string, scrollTop: number | null): void;
  /** Select a family; selecting the active family again closes the pane. */
  togglePaneFamily(sessionId: string, family: PaneFamily): void;
  setPaneOpen(sessionId: string, open: boolean): void;
  setPaneWidth(sessionId: string, width: number): void;
  setTerminalDrawerOpen(sessionId: string, open: boolean): void;
  setSessionPreview(
    sessionId: string,
    selection: SessionPreviewSelection,
  ): void;
  setSessionPreviewScale(sessionId: string, scale: PreviewScaleMode): void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;
export type WorkspaceStoreApi = StoreApi<WorkspaceStore>;

const INITIAL_STATE: WorkspaceState = {
  theme: "system",
  railWidth: RAIL_WIDTH.defaultWidth,
  railCollapsed: false,
  sessionListView: "current",
  railOverlayOpen: false,
  paletteOpen: false,
  activeSessionId: null,
  projectExpandedById: {},
  dismissedEmptyProjectIds: {},
  lastVisitedAtBySessionId: {},
  lastSeenAttentionOutcomeBySessionKey: {},
  sessionViewById: {},
};

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

function sanitizeTrueRecord(value: unknown): Record<string, true> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, true> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === true) result[key] = true;
  }
  return result;
}

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && Number.isFinite(Date.parse(entry))) result[key] = entry;
  }
  return result;
}

function sanitizeAttentionOutcomeRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, string> = {};
  for (const [sessionId, outcomeId] of Object.entries(value).slice(0, 1_000)) {
    if (
      sessionId.length > 0 &&
      sessionId.length <= 1_024 &&
      typeof outcomeId === "string" &&
      outcomeId.length > 0 &&
      outcomeId.length <= 1_024
    ) {
      result[sessionId] = outcomeId;
    }
  }
  return result;
}

function sanitizeSessionView(value: unknown): SessionViewState | null {
  if (typeof value !== "object" || value === null) return null;
  const view = value as Record<string, unknown>;
  const paneFamily = PANE_FAMILIES.find((family) => family === view.paneFamily);
  return {
    scrollTop: typeof view.scrollTop === "number" && view.scrollTop >= 0 ? view.scrollTop : null,
    draft: typeof view.draft === "string" ? view.draft : "",
    paneFamily: paneFamily ?? DEFAULT_SESSION_VIEW.paneFamily,
    paneOpen: view.paneOpen === true,
    paneWidth:
      typeof view.paneWidth === "number"
        ? clampWidth(view.paneWidth, RIGHT_PANE_WIDTH)
        : RIGHT_PANE_WIDTH.defaultWidth,
    terminalDrawerOpen: view.terminalDrawerOpen === true,
    previewId:
      typeof view.previewId === "string" &&
      view.previewId.length > 0 &&
      view.previewId.length <= 256 &&
      !/\p{Cc}/u.test(view.previewId)
        ? view.previewId
        : null,
    previewOptInKind:
      typeof view.previewOptInKind === "string" &&
      view.previewOptInKind.length > 0 &&
      view.previewOptInKind.length <= 256
        ? view.previewOptInKind
        : null,
    previewOptInAuthorityId:
      typeof view.previewOptInAuthorityId === "string" &&
      view.previewOptInAuthorityId.length > 0 &&
      view.previewOptInAuthorityId.length <= 256
        ? view.previewOptInAuthorityId
        : null,
    previewOptIn: view.previewOptIn === true,
    previewScale: view.previewScale === "actual" ? "actual" : "fit",
  };
}

/**
 * Parse a persisted snapshot. Anything malformed — wrong version, wrong
 * shape, bad entries — degrades to defaults instead of poisoning the shell.
 */
export function parsePersistedWorkspace(raw: unknown): WorkspaceState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = raw as Partial<PersistedWorkspaceState>;
  if (parsed.version !== 1 && parsed.version !== WORKSPACE_STATE_VERSION) return null;

  const sessionViewById: Record<string, SessionViewState> = {};
  if (typeof parsed.sessionViewById === "object" && parsed.sessionViewById !== null) {
    for (const [sessionId, view] of Object.entries(parsed.sessionViewById)) {
      const sanitized = sanitizeSessionView(view);
      if (sanitized !== null) sessionViewById[sessionId] = sanitized;
    }
  }

  return {
    ...INITIAL_STATE,
    theme:
      parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
        ? parsed.theme
        : INITIAL_STATE.theme,
    railWidth:
      typeof parsed.railWidth === "number"
        ? clampWidth(parsed.railWidth, RAIL_WIDTH)
        : RAIL_WIDTH.defaultWidth,
    railCollapsed: parsed.railCollapsed === true,
    sessionListView: parsed.sessionListView === "archived" ? "archived" : "current",
    activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
    projectExpandedById: sanitizeBooleanRecord(parsed.projectExpandedById),
    dismissedEmptyProjectIds: sanitizeTrueRecord(parsed.dismissedEmptyProjectIds),
    lastVisitedAtBySessionId: sanitizeTimestampRecord(parsed.lastVisitedAtBySessionId),
    lastSeenAttentionOutcomeBySessionKey: sanitizeAttentionOutcomeRecord(
      parsed.lastSeenAttentionOutcomeBySessionKey,
    ),
    sessionViewById,
  };
}

export function toPersistedWorkspace(state: WorkspaceState): PersistedWorkspaceState {
  return {
    version: WORKSPACE_STATE_VERSION,
    theme: state.theme,
    railWidth: state.railWidth,
    railCollapsed: state.railCollapsed,
    sessionListView: state.sessionListView,
    activeSessionId: state.activeSessionId,
    projectExpandedById: state.projectExpandedById,
    dismissedEmptyProjectIds: state.dismissedEmptyProjectIds,
    lastVisitedAtBySessionId: state.lastVisitedAtBySessionId,
    lastSeenAttentionOutcomeBySessionKey: state.lastSeenAttentionOutcomeBySessionKey,
    sessionViewById: state.sessionViewById,
  };
}

/** Adapted from T3 `markThreadVisited`: visits never move backward. */
export function markVisited(
  lastVisitedAtBySessionId: Record<string, string>,
  sessionId: string,
  visitedAt: string,
): Record<string, string> {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) return lastVisitedAtBySessionId;
  const previous = lastVisitedAtBySessionId[sessionId];
  const previousMs = previous === undefined ? Number.NaN : Date.parse(previous);
  if (Number.isFinite(previousMs) && previousMs >= visitedAtMs) {
    return lastVisitedAtBySessionId;
  }
  return { ...lastVisitedAtBySessionId, [sessionId]: visitedAt };
}

/**
 * Adapted from T3 `hasUnseenCompletion`: a session is unread when its latest
 * turn finished after the last visit. Never-visited sessions are not unread —
 * the user has no baseline to be behind.
 */
export function isSessionUnread(
  lastVisitedAt: string | undefined,
  latestTurnCompletedAt: string | null,
): boolean {
  if (latestTurnCompletedAt === null) return false;
  const completedMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedMs)) return false;
  if (lastVisitedAt === undefined) return false;
  const visitedMs = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedMs)) return true;
  return completedMs > visitedMs;
}

export function isAttentionOutcomeSeen(
  seenBySessionKey: Readonly<Record<string, string>>,
  sessionKey: string,
  outcomeId: string,
): boolean {
  return seenBySessionKey[sessionKey] === outcomeId;
}

/** View state for a session, with defaults for sessions never touched. */
export function selectSessionView(state: WorkspaceState, sessionId: string): SessionViewState {
  return state.sessionViewById[sessionId] ?? DEFAULT_SESSION_VIEW;
}

export interface CreateWorkspaceStoreOptions {
  readonly persistence: WorkspacePersistence;
  /** Applied over persisted (or initial) state at boot, e.g. fixture seeds. */
  readonly overrides?: Partial<WorkspaceState>;
}

export function createWorkspaceStore(options: CreateWorkspaceStoreOptions): WorkspaceStoreApi {
  const { persistence, overrides } = options;
  const persisted = parsePersistedWorkspace(persistence.load());
  const bootState: WorkspaceState = { ...(persisted ?? INITIAL_STATE), ...overrides };

  const updateSessionView = (
    state: WorkspaceStore,
    sessionId: string,
    patch: Partial<SessionViewState>,
  ): Pick<WorkspaceState, "sessionViewById"> => ({
    sessionViewById: {
      ...state.sessionViewById,
      [sessionId]: { ...selectSessionView(state, sessionId), ...patch },
    },
  });

  const store = createStore<WorkspaceStore>((set) => ({
    ...bootState,
    setTheme: (theme) => set({ theme }),
    setRailWidth: (width) => set({ railWidth: clampWidth(width, RAIL_WIDTH) }),
    setRailCollapsed: (collapsed) => set({ railCollapsed: collapsed }),
    setSessionListView: (view) => set({ sessionListView: view }),
    setRailOverlayOpen: (open) => set({ railOverlayOpen: open }),
    setPaletteOpen: (open) => set({ paletteOpen: open }),
    activateSession: (sessionId, visitedAt) =>
      set((state) => ({
        activeSessionId: sessionId,
        railOverlayOpen: false,
        lastVisitedAtBySessionId: markVisited(state.lastVisitedAtBySessionId, sessionId, visitedAt),
      })),
    markSessionVisited: (sessionId, visitedAt) =>
      set((state) => ({
        lastVisitedAtBySessionId: markVisited(state.lastVisitedAtBySessionId, sessionId, visitedAt),
      })),
    markAttentionOutcomeSeen: (sessionKey, outcomeId) =>
      set((state) => {
        if (
          sessionKey.length === 0 ||
          sessionKey.length > 1_024 ||
          outcomeId.length === 0 ||
          outcomeId.length > 1_024 ||
          state.lastSeenAttentionOutcomeBySessionKey[sessionKey] === outcomeId
        ) {
          return state;
        }
        return {
          lastSeenAttentionOutcomeBySessionKey: {
            ...state.lastSeenAttentionOutcomeBySessionKey,
            [sessionKey]: outcomeId,
          },
        };
      }),
    setProjectExpanded: (projectId, expanded) =>
      set((state) => ({
        projectExpandedById: { ...state.projectExpandedById, [projectId]: expanded },
      })),
    setEmptyProjectDismissed: (projectId, dismissed) =>
      set((state) => {
        if (dismissed) {
          return {
            dismissedEmptyProjectIds: { ...state.dismissedEmptyProjectIds, [projectId]: true },
          };
        }
        if (state.dismissedEmptyProjectIds[projectId] !== true) return state;
        const dismissedEmptyProjectIds = { ...state.dismissedEmptyProjectIds };
        delete dismissedEmptyProjectIds[projectId];
        return { dismissedEmptyProjectIds };
      }),
    setSessionDraft: (sessionId, draft) =>
      set((state) => updateSessionView(state, sessionId, { draft })),
    setSessionScrollTop: (sessionId, scrollTop) =>
      set((state) => updateSessionView(state, sessionId, { scrollTop })),
    togglePaneFamily: (sessionId, family) =>
      set((state) => {
        const view = selectSessionView(state, sessionId);
        const closing = view.paneOpen && view.paneFamily === family;
        return updateSessionView(state, sessionId, {
          paneFamily: family,
          paneOpen: !closing,
        });
      }),
    setPaneOpen: (sessionId, open) =>
      set((state) => updateSessionView(state, sessionId, { paneOpen: open })),
    setPaneWidth: (sessionId, paneWidth) =>
      set((state) =>
        updateSessionView(state, sessionId, {
          paneWidth: clampWidth(paneWidth, RIGHT_PANE_WIDTH),
        }),
      ),
    setTerminalDrawerOpen: (sessionId, open) =>
      set((state) => updateSessionView(state, sessionId, { terminalDrawerOpen: open })),
    setSessionPreview: (sessionId, selection) =>
      set((state) =>
        updateSessionView(state, sessionId, {
          previewId: selection.previewId,
          previewOptInKind: selection.optInKind ?? null,
          previewOptInAuthorityId: selection.optInAuthorityId ?? null,
          previewOptIn: selection.optIn,
        }),
      ),
    setSessionPreviewScale: (sessionId, previewScale) =>
      set((state) => updateSessionView(state, sessionId, { previewScale })),
  }));

  store.subscribe((state) => persistence.save(toPersistedWorkspace(state)));
  return store;
}
