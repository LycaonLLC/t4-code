// Desktop no-session states: what the center pane says when the shell has
// zero sessions to show. Everything here derives from the runtime snapshot
// and the typed shell port's service inspection — connecting, a local
// service that needs attention, a genuinely empty connected host, or a
// bounded startup error. No fixture reads, no invented progress, and no
// path or log content beyond the backend's safe display text.
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import type { ServiceInspection } from "@t4-code/protocol/desktop-ipc";

export type DesktopHomeState =
  | { readonly kind: "connecting" }
  /** Connected with genuinely zero sessions. */
  | { readonly kind: "empty" }
  /** A configured remote target needs a one-time pairing code. */
  | { readonly kind: "pairing-required"; readonly targetId: string; readonly label: string }
  /** The local service needs attention before sessions can exist. */
  | { readonly kind: "service" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Classify the zero-session desktop home. Connection truth wins over the
 * remembered start state: a runtime that errored at bootstrap but later
 * reached the local host renders as connected, and a retry that succeeds
 * clears the error without a restart. Browser-direct mode has one remote
 * target instead of the desktop's "local" target, so it follows the same
 * state machine rather than falling back to the local-service card.
 */
export function deriveDesktopHomeState(snapshot: DesktopRuntimeSnapshot): DesktopHomeState {
  const localConnection = snapshot.connections.get("local");
  const targetId =
    localConnection === undefined ? snapshot.connections.keys().next().value : "local";
  const connection = targetId === undefined ? undefined : snapshot.connections.get(targetId);
  const target = targetId === undefined ? undefined : snapshot.targets.get(targetId);
  if (connection === "connected") return { kind: "empty" };
  if (targetId !== undefined && connection === "pairing-required") {
    return {
      kind: "pairing-required",
      targetId,
      label: target?.label ?? "Remote OMP host",
    };
  }
  if (snapshot.startState === "idle" || snapshot.startState === "starting" || connection === "connecting") {
    return { kind: "connecting" };
  }
  if (snapshot.startState === "error") {
    const last = snapshot.runtimeErrors.at(-1);
    return {
      kind: "error",
      message: last?.message ?? "The desktop runtime could not start.",
    };
  }
  return { kind: "service" };
}

// ---------------------------------------------------------------------------
// Service card view model (mirrors the onboarding service card's language)
// ---------------------------------------------------------------------------

export type HomeServiceActionId = "install" | "start" | "retry" | "inspect";

export interface HomeServiceView {
  readonly label: string;
  readonly tone: "working" | "success" | "error" | "muted";
  readonly live: boolean;
  /** One sentence naming what is true right now. */
  readonly detail: string;
  /** Safe evidence line from the backend; null when clean. */
  readonly diagnostics: string | null;
  /** The one action that moves things forward; null while in motion. */
  readonly primary: Exclude<HomeServiceActionId, "inspect"> | null;
  readonly primaryLabel: string | null;
}

export interface HomeServiceSupport {
  readonly inspect: boolean;
  readonly install: boolean;
  readonly start: boolean;
}

/**
 * Fold a service inspection into display truth. Success language appears
 * only for states the backend actually reported; a null inspection is
 * "still checking", never an optimistic default.
 */
export function deriveHomeServiceView(
  inspection: ServiceInspection | null,
  support: HomeServiceSupport,
  failure: string | null = null,
): HomeServiceView {
  if (!support.inspect) {
    return {
      label: "Not connected",
      tone: "muted",
      live: false,
      detail: "This window cannot manage the local service. Retry the connection.",
      diagnostics: null,
      primary: "retry",
      primaryLabel: "Retry connection",
    };
  }
  if (inspection === null && failure !== null) {
    return {
      label: failure.includes("incompatible") ? "OMP update required" : "Check failed",
      tone: "error",
      live: false,
      detail: failure,
      diagnostics: null,
      primary: null,
      primaryLabel: null,
    };
  }
  if (inspection === null) {
    return {
      label: "Checking",
      tone: "working",
      live: true,
      detail: "Looking at the local service…",
      diagnostics: null,
      primary: null,
      primaryLabel: null,
    };
  }
  const diagnostics = inspection.diagnostics !== "" ? inspection.diagnostics : null;
  const drift =
    inspection.definition === "drifted" ? " The installed service definition is out of date." : "";
  if (inspection.definition === "missing") {
    return {
      label: "Not installed",
      tone: "muted",
      live: false,
      detail: "No local service is installed on this machine yet.",
      diagnostics,
      primary: support.install ? "install" : null,
      primaryLabel: support.install ? "Install the service" : null,
    };
  }
  switch (inspection.service) {
    case "running":
      return {
        label: "Running",
        tone: "success",
        live: false,
        detail: `The local service is running, but this window is not connected to it yet.${drift}`,
        diagnostics,
        primary: "retry",
        primaryLabel: "Reconnect",
      };
    case "starting":
      return {
        label: "Starting",
        tone: "working",
        live: true,
        detail: `The local service is starting…${drift}`,
        diagnostics,
        primary: null,
        primaryLabel: null,
      };
    case "failed":
      return {
        label: "Could not start",
        tone: "error",
        live: false,
        detail: `The local service failed to start.${drift}`,
        diagnostics,
        primary: support.start ? "start" : null,
        primaryLabel: support.start ? "Try again" : null,
      };
    case "stopped":
      return {
        label: "Installed, not running",
        tone: "muted",
        live: false,
        detail: `The local service is installed but not running.${drift}`,
        diagnostics,
        primary: support.start ? "start" : null,
        primaryLabel: support.start ? "Start it" : null,
      };
    case "unknown":
      return {
        label: "Status unknown",
        tone: "muted",
        live: false,
        detail: `Could not read the local service state.${drift}`,
        diagnostics,
        primary: "retry",
        primaryLabel: "Retry connection",
      };
  }
}

// ---------------------------------------------------------------------------
// Serialized actions
// ---------------------------------------------------------------------------

export interface HomeActionsDeps {
  readonly serviceInspect?: () => Promise<ServiceInspection>;
  readonly serviceInstall?: () => Promise<unknown>;
  readonly serviceStart?: () => Promise<unknown>;
  /** Reconnect the local target through the runtime controller. */
  readonly connectLocal: () => Promise<unknown>;
}

export interface HomeActionsState {
  /** The action currently running; every affordance disables while set. */
  readonly pending: HomeServiceActionId | null;
  /** The most recent inspection the backend reported. */
  readonly inspection: ServiceInspection | null;
  /** Set when the last action did not complete; cleared on the next one. */
  readonly failure: string | null;
  /** Consecutive failed service reads, used only to pace automatic recovery. */
  readonly consecutiveInspectionFailures: number;
}

export interface HomeActions {
  readonly getState: () => HomeActionsState;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Run one action. Actions serialize: while one is pending, further calls
   * are dropped. Every action ends with a fresh inspection so the card
   * always renders what the backend reported after the work, never an
   * optimistic guess.
   */
  readonly run: (action: HomeServiceActionId) => Promise<void>;
}

const ACTION_FAILURE: Readonly<Record<HomeServiceActionId, string>> = {
  install: "The install did not complete. Try again.",
  start: "The service did not confirm a start. Try again.",
  retry: "Still not connected. The service state below is current.",
  inspect: "Could not read the service state. Try again.",
};

const SERVICE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

export function homeServiceRetryDelay(failureCount: number): number {
  const index = Math.max(0, Math.min(Math.trunc(failureCount) - 1, SERVICE_RETRY_DELAYS_MS.length - 1));
  return SERVICE_RETRY_DELAYS_MS[index] ?? SERVICE_RETRY_DELAYS_MS[0];
}

export function shouldInspectHomeService(
  needsInspection: boolean,
  inspectAvailable: boolean,
  state: HomeActionsState,
): boolean {
  return (
    needsInspection &&
    inspectAvailable &&
    state.inspection === null &&
    state.pending === null &&
    state.failure === null
  );
}

function boundedActionFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.length === 0) return fallback;
  return message
    .replace(/https?:\/\/[^\s]+/giu, "[redacted]")
    .replace(/\b(?:token|secret|password|credential|authorization)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(?:^|\s)(?:~|\/(?:home|tmp|var|etc|opt|srv|mnt|run|usr)\/[^\s,;]*)/gu, " [redacted]")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 512)
    .trim();
}

export function createHomeActions(deps: HomeActionsDeps): HomeActions {
  let state: HomeActionsState = {
    pending: null,
    inspection: null,
    failure: null,
    consecutiveInspectionFailures: 0,
  };
  const listeners = new Set<() => void>();
  const replace = (next: HomeActionsState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async run(action) {
      if (state.pending !== null) return;
      replace({ ...state, pending: action, failure: null });
      let failure: string | null = null;
      try {
        if (action === "install") await deps.serviceInstall?.();
        else if (action === "start") await deps.serviceStart?.();
        else if (action === "retry") await deps.connectLocal();
      } catch (error) {
        failure = boundedActionFailure(error, ACTION_FAILURE[action]);
      }
      let inspection = state.inspection;
      let consecutiveInspectionFailures = state.consecutiveInspectionFailures;
      if (deps.serviceInspect !== undefined) {
        try {
          inspection = await deps.serviceInspect();
          consecutiveInspectionFailures = 0;
        } catch (error) {
          failure = failure ?? boundedActionFailure(error, ACTION_FAILURE.inspect);
          consecutiveInspectionFailures += 1;
        }
      }
      replace({ pending: null, inspection, failure, consecutiveInspectionFailures });
    },
  };
}
