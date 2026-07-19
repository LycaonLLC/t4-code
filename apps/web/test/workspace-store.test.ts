// Pure store tests: session-switch continuity, visited/unread, persistence
// sanitizing, and layout clamping. No DOM.
import { describe, expect, it } from "vite-plus/test";

import { createMemoryPersistence } from "../src/state/persistence.ts";
import {
  createWorkspaceStore,
  DEFAULT_SESSION_VIEW,
  isAttentionOutcomeSeen,
  isSessionUnread,
  markVisited,
  parsePersistedWorkspace,
  RAIL_WIDTH,
  RIGHT_PANE_WIDTH,
  selectSessionView,
  toPersistedWorkspace,
  WORKSPACE_STATE_VERSION,
} from "../src/state/workspace-store.ts";

function makeStore(initialPersisted?: unknown) {
  const persistence = createMemoryPersistence(initialPersisted);
  return { store: createWorkspaceStore({ persistence }), persistence };
}

describe("session continuity (A→B→A)", () => {
  it("preserves transcript, pane, drawer, and preview state per session", () => {
    const { store } = makeStore();
    const s = () => store.getState();

    s().activateSession("A", "2026-07-11T10:00:00Z");
    s().setSessionDraft("A", "half-written prompt");
    s().setSessionScrollTop("A", 420);
    s().togglePaneFamily("A", "review");
    s().setPaneWidth("A", 500);
    s().setTerminalDrawerOpen("A", true);
    s().setSessionPreview("A", {
      previewId: "preview-a",
      optInKind: "authenticated-profile",
      optInAuthorityId: "auth-a",
      optIn: true,
    });
    s().setSessionPreviewScale("A", "actual");

    s().activateSession("B", "2026-07-11T10:01:00Z");
    s().setSessionDraft("B", "other draft");
    s().togglePaneFamily("B", "files");
    s().togglePaneFamily("B", "files"); // close again
    s().setSessionScrollTop("B", 7);
    s().setSessionPreview("B", { previewId: "preview-b", optIn: false });

    s().activateSession("A", "2026-07-11T10:02:00Z");
    const viewA = selectSessionView(s(), "A");
    expect(viewA.draft).toBe("half-written prompt");
    expect(viewA.scrollTop).toBe(420);
    expect(viewA.paneFamily).toBe("review");
    expect(viewA.paneOpen).toBe(true);
    expect(viewA.paneWidth).toBe(500);
    expect(viewA.terminalDrawerOpen).toBe(true);
    expect(viewA.previewId).toBe("preview-a");
    expect(viewA.previewOptIn).toBe(true);
    expect(viewA.previewOptInKind).toBe("authenticated-profile");
    expect(viewA.previewOptInAuthorityId).toBe("auth-a");
    expect(viewA.previewScale).toBe("actual");

    const viewB = selectSessionView(s(), "B");
    expect(viewB.draft).toBe("other draft");
    expect(viewB.paneFamily).toBe("files");
    expect(viewB.paneOpen).toBe(false);
    expect(viewB.scrollTop).toBe(7);
    expect(viewB.terminalDrawerOpen).toBe(false);
    expect(viewB.previewId).toBe("preview-b");
    expect(viewB.previewOptIn).toBe(false);
    expect(viewB.previewScale).toBe("fit");
  });

  it("returns defaults for sessions never touched", () => {
    const { store } = makeStore();
    expect(selectSessionView(store.getState(), "unknown")).toEqual(DEFAULT_SESSION_VIEW);
  });

  it("selecting the open family again closes the pane; another family switches", () => {
    const { store } = makeStore();
    const s = () => store.getState();
    s().togglePaneFamily("A", "agents");
    expect(selectSessionView(s(), "A").paneOpen).toBe(true);
    s().togglePaneFamily("A", "terminals");
    expect(selectSessionView(s(), "A").paneFamily).toBe("terminals");
    expect(selectSessionView(s(), "A").paneOpen).toBe(true);
    s().togglePaneFamily("A", "terminals");
    expect(selectSessionView(s(), "A").paneOpen).toBe(false);
    expect(selectSessionView(s(), "A").paneFamily).toBe("terminals");
  });
});

describe("visited and unread", () => {
  it("visits never move backward", () => {
    const visited = markVisited({}, "A", "2026-07-11T10:05:00Z");
    const rewound = markVisited(visited, "A", "2026-07-11T10:00:00Z");
    expect(rewound["A"]).toBe("2026-07-11T10:05:00Z");
    const advanced = markVisited(rewound, "A", "2026-07-11T10:06:00Z");
    expect(advanced["A"]).toBe("2026-07-11T10:06:00Z");
  });

  it("ignores malformed timestamps", () => {
    const visited = markVisited({}, "A", "not a date");
    expect(visited["A"]).toBeUndefined();
  });

  it("unread means the latest turn finished after the last visit", () => {
    expect(isSessionUnread("2026-07-11T10:00:00Z", "2026-07-11T10:01:00Z")).toBe(true);
    expect(isSessionUnread("2026-07-11T10:02:00Z", "2026-07-11T10:01:00Z")).toBe(false);
    expect(isSessionUnread(undefined, "2026-07-11T10:01:00Z")).toBe(false);
    expect(isSessionUnread("2026-07-11T10:00:00Z", null)).toBe(false);
    expect(isSessionUnread("garbage", "2026-07-11T10:01:00Z")).toBe(true);
  });

  it("activateSession stamps the visit and closes the overlay rail", () => {
    const { store } = makeStore();
    store.getState().setRailOverlayOpen(true);
    store.getState().activateSession("A", "2026-07-11T10:00:00Z");
    expect(store.getState().activeSessionId).toBe("A");
    expect(store.getState().railOverlayOpen).toBe(false);
    expect(store.getState().lastVisitedAtBySessionId["A"]).toBe("2026-07-11T10:00:00Z");
  });

  it("tracks the latest seen attention outcome per session", () => {
    const { store } = makeStore();
    expect(isAttentionOutcomeSeen(store.getState().lastSeenAttentionOutcomeBySessionKey, "A", "one"))
      .toBe(false);
    store.getState().markAttentionOutcomeSeen("A", "one");
    expect(isAttentionOutcomeSeen(store.getState().lastSeenAttentionOutcomeBySessionKey, "A", "one"))
      .toBe(true);
    store.getState().markAttentionOutcomeSeen("A", "two");
    expect(store.getState().lastSeenAttentionOutcomeBySessionKey).toEqual({ A: "two" });
  });
});

describe("persistence", () => {
  it("round-trips through the adapter and restores continuity", () => {
    const persistence = createMemoryPersistence();
    const first = createWorkspaceStore({ persistence });
    first.getState().activateSession("A", "2026-07-11T10:00:00Z");
    first.getState().setSessionDraft("A", "resume me");
    first.getState().setRailWidth(300);
    first.getState().setTheme("dark");
    first.getState().setEmptyProjectDismissed("host/project", true);
    first.getState().setSessionPreview("A", {
      previewId: "preview-a",
      optInKind: "authenticated-profile",
      optInAuthorityId: "auth-a",
      optIn: true,
    });
    first.getState().setSessionPreviewScale("A", "actual");
    first.getState().markAttentionOutcomeSeen("A", "outcome-1");
    first.getState().setPaletteOpen(true); // ephemeral, must not persist

    const second = createWorkspaceStore({ persistence });
    const state = second.getState();
    expect(state.activeSessionId).toBe("A");
    expect(selectSessionView(state, "A").draft).toBe("resume me");
    expect(selectSessionView(state, "A").previewId).toBe("preview-a");
    expect(selectSessionView(state, "A").previewOptIn).toBe(true);
    expect(selectSessionView(state, "A").previewOptInKind).toBe("authenticated-profile");
    expect(selectSessionView(state, "A").previewOptInAuthorityId).toBe("auth-a");
    expect(selectSessionView(state, "A").previewScale).toBe("actual");
    expect(state.railWidth).toBe(300);
    expect(state.theme).toBe("dark");
    expect(state.dismissedEmptyProjectIds).toEqual({ "host/project": true });
    expect(state.lastSeenAttentionOutcomeBySessionKey).toEqual({ A: "outcome-1" });
    expect(state.paletteOpen).toBe(false);
    expect(state.railOverlayOpen).toBe(false);
  });

  it("loads a v1 snapshot written before empty-project dismissals existed", () => {
    const parsed = parsePersistedWorkspace({
      version: 1,
      theme: "dark",
      railWidth: 312,
      railCollapsed: true,
      sessionListView: "archived",
      activeSessionId: "A",
      projectExpandedById: { project: false },
      lastVisitedAtBySessionId: { A: "2026-07-11T10:00:00Z" },
      sessionViewById: {
        A: {
          scrollTop: 42,
          draft: "old draft",
          paneFamily: "files",
          paneOpen: true,
          paneWidth: 400,
          terminalDrawerOpen: false,
        },
      },
    });

    expect(parsed).toMatchObject({
      theme: "dark",
      railWidth: 312,
      railCollapsed: true,
      sessionListView: "archived",
      activeSessionId: "A",
      projectExpandedById: { project: false },
      dismissedEmptyProjectIds: {},
      lastVisitedAtBySessionId: { A: "2026-07-11T10:00:00Z" },
      lastSeenAttentionOutcomeBySessionKey: {},
    });
    expect(parsed?.sessionViewById.A).toMatchObject({
      scrollTop: 42,
      draft: "old draft",
      paneFamily: "files",
      paneOpen: true,
      paneWidth: 400,
    });
    expect(parsed?.sessionViewById.A).toMatchObject({
      previewId: null,
      previewScale: "fit",
    });
  });

  it("does not grant consent to persisted preview selections from before the opt-in marker", () => {
    const parsed = parsePersistedWorkspace({
      version: WORKSPACE_STATE_VERSION,
      sessionViewById: {
        A: {
          previewId: "legacy-preview",
          previewOptInKind: null,
          previewOptInAuthorityId: null,
        },
      },
    });

    expect(parsed?.sessionViewById.A).toMatchObject({
      previewId: "legacy-preview",
      previewOptIn: false,
      previewOptInKind: null,
      previewOptInAuthorityId: null,
    });
  });

  it("rejects wrong versions and non-objects", () => {
    expect(parsePersistedWorkspace(null)).toBeNull();
    expect(parsePersistedWorkspace("junk")).toBeNull();
    expect(parsePersistedWorkspace({ version: 999 })).toBeNull();
  });

  it("sanitizes malformed fields instead of importing them", () => {
    const parsed = parsePersistedWorkspace({
      version: WORKSPACE_STATE_VERSION,
      theme: "neon",
      railWidth: 10_000,
      railCollapsed: "yes",
      activeSessionId: 42,
      projectExpandedById: { good: true, bad: "nope" },
      dismissedEmptyProjectIds: { good: true, falseEntry: false, bad: "yes" },
      lastVisitedAtBySessionId: { good: "2026-07-11T10:00:00Z", bad: "not a date" },
      lastSeenAttentionOutcomeBySessionKey: {
        good: "outcome-1",
        empty: "",
        invalid: 42,
      },
      sessionViewById: {
        good: {
          paneFamily: "made-up",
          paneWidth: 5,
          scrollTop: -3,
          draft: 9,
          previewId: "bad\u0000id",
          previewScale: "giant",
        },
        bad: null,
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.theme).toBe("system");
    expect(parsed?.railWidth).toBe(RAIL_WIDTH.maxWidth);
    expect(parsed?.railCollapsed).toBe(false);
    expect(parsed?.activeSessionId).toBeNull();
    expect(parsed?.projectExpandedById).toEqual({ good: true });
    expect(parsed?.dismissedEmptyProjectIds).toEqual({ good: true });
    expect(parsed?.lastVisitedAtBySessionId).toEqual({ good: "2026-07-11T10:00:00Z" });
    expect(parsed?.lastSeenAttentionOutcomeBySessionKey).toEqual({ good: "outcome-1" });
    const view = parsed?.sessionViewById["good"];
    expect(view?.paneFamily).toBe("agents");
    expect(view?.paneWidth).toBe(RIGHT_PANE_WIDTH.minWidth);
    expect(view?.scrollTop).toBeNull();
    expect(view?.draft).toBe("");
    expect(view?.previewId).toBeNull();
    expect(view?.previewScale).toBe("fit");
    expect(parsed?.sessionViewById["bad"]).toBeUndefined();
  });

  it("never writes ephemeral overlay state", () => {
    const { store } = makeStore();
    store.getState().setPaletteOpen(true);
    store.getState().setRailOverlayOpen(true);
    const snapshot = toPersistedWorkspace(store.getState()) as unknown as Record<string, unknown>;
    expect("paletteOpen" in snapshot).toBe(false);
    expect("railOverlayOpen" in snapshot).toBe(false);
  });

  it("can clear an empty-project dismissal without disturbing other projects", () => {
    const { store } = makeStore();
    store.getState().setEmptyProjectDismissed("same-name/project-a", true);
    store.getState().setEmptyProjectDismissed("same-name/project-b", true);
    store.getState().setEmptyProjectDismissed("same-name/project-a", false);

    expect(store.getState().dismissedEmptyProjectIds).toEqual({
      "same-name/project-b": true,
    });
  });
});

describe("layout clamping", () => {
  it("clamps rail and pane widths to bounds", () => {
    const { store } = makeStore();
    store.getState().setRailWidth(50);
    expect(store.getState().railWidth).toBe(RAIL_WIDTH.minWidth);
    store.getState().setRailWidth(9_999);
    expect(store.getState().railWidth).toBe(RAIL_WIDTH.maxWidth);
    store.getState().setPaneWidth("A", 1);
    expect(selectSessionView(store.getState(), "A").paneWidth).toBe(RIGHT_PANE_WIDTH.minWidth);
  });
});
