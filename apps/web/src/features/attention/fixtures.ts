import type {
  AttentionInboxItem,
  AttentionInventoryState,
  AttentionSessionIdentity,
} from "./model.ts";

export const ATTENTION_FIXTURE_NOW_MS = Date.UTC(2026, 6, 18, 18, 0, 0);

const SETTINGS_SESSION: AttentionSessionIdentity = {
  hostId: "host-local",
  sessionId: "sess-settings",
  title: "Migrate settings store to schema v3",
  project: "oh-my-pi",
};

const PLAN_SESSION: AttentionSessionIdentity = {
  hostId: "host-local",
  sessionId: "sess-bundle",
  title: "Split renderer bundle for faster cold start",
  project: "oh-my-pi",
};

const FIXTURES_SESSION: AttentionSessionIdentity = {
  hostId: "host-local",
  sessionId: "sess-fixtures",
  title: "Pin protocol fixtures for desktop CI",
  project: "t4-code",
};

const RESIZE_SESSION: AttentionSessionIdentity = {
  hostId: "host-local",
  sessionId: "sess-resize",
  title: "Bisect flaky terminal resize test",
  project: "t4-code",
};

const mixedItems: readonly AttentionInboxItem[] = [
  {
    kind: "approval",
    key: "host-local:sess-settings:approval:migration",
    requestId: "approval-migration",
    session: SETTINGS_SESSION,
    title: "Migrate the local seen-state store",
    summary: "The agent wants to run the workspace-state migration and its focused tests.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 2 * 60_000,
    actionState: { status: "ready" },
  },
  {
    kind: "question",
    key: "host-local:sess-fixtures:question:fixtures",
    requestId: "question-fixtures",
    session: FIXTURES_SESSION,
    title: "Choose the protocol fixture set",
    summary: "Which compatibility cases should remain in the first release gate?",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 9 * 60_000,
    options: [
      { id: "strict", label: "Strict and legacy", detail: "Keep both decoder paths covered." },
      { id: "strict-only", label: "Strict only", detail: "Remove the compatibility fixture." },
    ],
    allowText: true,
    multiple: false,
    actionState: { status: "observer", message: "Active in another app" },
  },
  {
    kind: "plan",
    key: "host-local:sess-bundle:plan:vertical-slice",
    requestId: "plan-vertical-slice",
    session: PLAN_SESSION,
    title: "Review the end-to-end release plan",
    summary: "The plan covers host projection, the client inbox, focused tests, and release proof.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 14 * 60_000,
    actionState: { status: "resolving" },
  },
  {
    kind: "approval",
    key: "host-local:sess-settings:approval:retry",
    requestId: "approval-retry",
    session: SETTINGS_SESSION,
    title: "Retry the failed fixture update",
    summary: "The previous response did not reach the host. The request is still current.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 18 * 60_000,
    actionState: {
      status: "error",
      message: "The host rejected the response. Check the session and try again.",
    },
  },
  {
    kind: "failed",
    key: "host-local:sess-resize:outcome:failed-137",
    outcomeId: "failed-137",
    session: RESIZE_SESSION,
    title: "Terminal resize check failed",
    summary: "The test process exited with code 137 before the final narrow-window check.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 48 * 60_000,
    seen: false,
  },
  {
    kind: "completed",
    key: "host-local:sess-motion:outcome:complete",
    outcomeId: "complete-motion",
    session: {
      hostId: "host-local",
      sessionId: "sess-motion",
      title: "Add reduced-motion audit to gallery",
      project: "t4-code",
    },
    title: "Reduced-motion audit completed",
    summary: "All seven focused interaction checks passed.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 31 * 60_000,
    seen: false,
  },
  {
    kind: "completed",
    key: "host-local:sess-notes:outcome:complete",
    outcomeId: "complete-release-notes",
    session: {
      hostId: "host-local",
      sessionId: "sess-notes",
      title: "Draft release notes for v0.1",
      project: "t4-code",
    },
    title: "Release-notes draft saved",
    summary: "The current draft is ready for the next release checkpoint.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 3 * 60 * 60_000,
    seen: true,
  },
];

const unavailableItems: readonly AttentionInboxItem[] = [
  {
    kind: "confirmation",
    key: "host-local:sess-settings:confirmation:expired",
    requestId: "confirmation-expired",
    session: SETTINGS_SESSION,
    title: "Confirm access to the release directory",
    summary: "This security check belonged to an older live connection.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 3 * 60_000,
    expiresAtMs: ATTENTION_FIXTURE_NOW_MS - 2 * 60_000,
    actionState: { status: "expired" },
  },
  {
    kind: "approval",
    key: "host-local:sess-fixtures:approval:offline",
    requestId: "approval-offline",
    session: FIXTURES_SESSION,
    title: "Write the bounded outcome ledger",
    summary: "Reconnect Studio Mac before responding to this request.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 6 * 60_000,
    actionState: { status: "offline" },
  },
  {
    kind: "question",
    key: "host-local:sess-fixtures:question:stale",
    requestId: "question-stale",
    session: FIXTURES_SESSION,
    title: "Pick the narrow-screen action layout",
    summary: "The host has published a newer session revision.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 11 * 60_000,
    options: [{ id: "stack", label: "Stack the actions" }],
    allowText: false,
    multiple: false,
    actionState: { status: "stale" },
  },
  {
    kind: "plan",
    key: "host-local:sess-bundle:plan:unsupported",
    requestId: "plan-unsupported",
    session: PLAN_SESSION,
    title: "Review a plan from an older host",
    summary: "This host version cannot accept plan decisions from the inbox.",
    occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 19 * 60_000,
    actionState: { status: "unsupported" },
  },
];

export interface AttentionInboxFixture {
  readonly nowMs: number;
  readonly items: readonly AttentionInboxItem[];
  readonly inventory: AttentionInventoryState;
}

export const ATTENTION_INBOX_FIXTURES = {
  /** Matches the built-in sample rail one-for-one; safe for browser showcase mode. */
  sample: {
    nowMs: ATTENTION_FIXTURE_NOW_MS,
    items: mixedItems,
    inventory: { status: "complete" },
  },
  empty: {
    nowMs: ATTENTION_FIXTURE_NOW_MS,
    items: [],
    inventory: { status: "complete" },
  },
  mixed: {
    nowMs: ATTENTION_FIXTURE_NOW_MS,
    items: mixedItems,
    inventory: { status: "complete" },
  },
  partial: {
    nowMs: ATTENTION_FIXTURE_NOW_MS,
    items: mixedItems.slice(0, 3),
    inventory: {
      status: "partial",
      message:
        "Studio Mac has only published part of its session list. This inbox may be incomplete.",
    },
  },
  offline: {
    nowMs: ATTENTION_FIXTURE_NOW_MS,
    items: unavailableItems,
    inventory: {
      status: "offline",
      message: "One or more hosts are offline. Reconnect before answering their requests.",
    },
  },
} as const satisfies Readonly<Record<string, AttentionInboxFixture>>;
