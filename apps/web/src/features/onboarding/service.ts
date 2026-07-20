// Local T4 host service view model. The desktop backend owns the real
// systemd/launchd calls; the renderer only renders what the backend reports
// and never invents progress. "Running" appears exactly when the backend
// confirmed it — there is no optimistic success state.

export type ServicePlatform = "systemd" | "launchd";

export type ServiceStatus =
  | "checking"
  | "not-installed"
  | "installing"
  | "install-failed"
  | "stopped"
  | "starting"
  | "start-failed"
  | "running";

export const SERVICE_PLATFORM_LABELS: Readonly<Record<ServicePlatform, string>> = {
  systemd: "systemd user service",
  launchd: "launchd agent",
};

/**
 * What the service card renders. `detail` and `diagnostics` are safe display
 * text from the backend — summaries, exit codes, and counts, never unit file
 * paths or raw journal lines.
 */
export interface ServiceViewModel {
  readonly platform: ServicePlatform;
  readonly status: ServiceStatus;
  /** Host version, once one has responded. */
  readonly version: string | null;
  /** One sentence naming what is true right now. */
  readonly detail: string;
  /** Safe evidence lines behind "Open diagnostics"; empty when clean. */
  readonly diagnostics: readonly string[];
}

export type ServiceEvent =
  | { readonly kind: "check-found-running"; readonly version: string }
  | { readonly kind: "check-found-stopped" }
  | { readonly kind: "check-missing" }
  | { readonly kind: "install-requested" }
  | { readonly kind: "install-succeeded" }
  | { readonly kind: "install-failed"; readonly detail: string; readonly diagnostics: readonly string[] }
  | { readonly kind: "start-requested" }
  | { readonly kind: "start-confirmed"; readonly version: string }
  | { readonly kind: "start-failed"; readonly detail: string; readonly diagnostics: readonly string[] };

export function initialService(platform: ServicePlatform): ServiceViewModel {
  return {
    platform,
    status: "checking",
    version: null,
    detail: "Looking for a local T4 host…",
    diagnostics: [],
  };
}

/**
 * Fold a backend report into the view model. Success states only ever come
 * from `check-found-running` / `start-confirmed` — the two events the
 * backend sends after it has actually talked to the host.
 */
export function serviceReduce(state: ServiceViewModel, event: ServiceEvent): ServiceViewModel {
  const unit = SERVICE_PLATFORM_LABELS[state.platform];
  switch (event.kind) {
    case "check-found-running":
      return {
        ...state,
        status: "running",
        version: event.version,
        detail: `T4 host ${event.version} is running as a ${unit}.`,
        diagnostics: [],
      };
    case "check-found-stopped":
      return {
        ...state,
        status: "stopped",
        detail: `The ${unit} is installed but not running.`,
      };
    case "check-missing":
      return {
        ...state,
        status: "not-installed",
        detail: `No ${unit} is installed for the T4 host yet.`,
      };
    case "install-requested":
      return {
        ...state,
        status: "installing",
        detail: `Installing the ${unit}…`,
      };
    case "install-succeeded":
      return {
        ...state,
        status: "stopped",
        detail: `The ${unit} is installed. Start it to continue.`,
        diagnostics: [],
      };
    case "install-failed":
      return {
        ...state,
        status: "install-failed",
        detail: event.detail,
        diagnostics: event.diagnostics,
      };
    case "start-requested":
      return {
        ...state,
        status: "starting",
        detail: "Starting the T4 host…",
      };
    case "start-confirmed":
      return {
        ...state,
        status: "running",
        version: event.version,
        detail: `T4 host ${event.version} is running as a ${unit}.`,
        diagnostics: [],
      };
    case "start-failed":
      return {
        ...state,
        status: "start-failed",
        detail: event.detail,
        diagnostics: event.diagnostics,
      };
  }
}

export interface ServiceStatusMeta {
  readonly label: string;
  readonly tone: "working" | "success" | "error" | "muted";
  readonly live: boolean;
}

export const SERVICE_STATUS_META: Readonly<Record<ServiceStatus, ServiceStatusMeta>> = {
  checking: { label: "Checking", tone: "working", live: true },
  "not-installed": { label: "Not installed", tone: "muted", live: false },
  installing: { label: "Installing", tone: "working", live: true },
  "install-failed": { label: "Install failed", tone: "error", live: false },
  stopped: { label: "Installed, not running", tone: "muted", live: false },
  starting: { label: "Starting", tone: "working", live: true },
  "start-failed": { label: "Could not start", tone: "error", live: false },
  running: { label: "Running", tone: "success", live: false },
};
