import type { PreviewProjection } from "@t4-code/client";

export type PreviewWorkspaceStatus =
  | "empty"
  | "launching"
  | "ready"
  | "running"
  | "stopped"
  | "failed"
  | "offline"
  | "unsupported"
  | "cached";

export type PreviewAction =
  | "activate"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "close"
  | "capture"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "scroll"
  | "select"
  | "upload";

export interface PreviewActionSupport {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface PreviewPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface PreviewHostSupport {
  readonly supported: boolean;
  readonly controlSupported: boolean;
  readonly inputSupported: boolean;
  readonly reason?: string;
}

export function previewHostSupport(host: {
  readonly grantedCapabilities: readonly string[];
  readonly grantedFeatures: readonly string[];
} | undefined): PreviewHostSupport {
  if (host === undefined || !host.grantedFeatures.includes("preview.control")) {
    return {
      supported: false,
      controlSupported: false,
      inputSupported: false,
      reason: "This host does not advertise browser preview control.",
    };
  }
  if (!host.grantedCapabilities.includes("preview.read")) {
    return {
      supported: false,
      controlSupported: false,
      inputSupported: false,
      reason: "This host does not permit browser preview reads.",
    };
  }
  const controlSupported = host.grantedCapabilities.includes("preview.control");
  return {
    supported: true,
    controlSupported,
    inputSupported: controlSupported && host.grantedCapabilities.includes("preview.input"),
  };
}

export function derivePreviewWorkspaceStatus(options: {
  readonly preview: PreviewProjection | undefined;
  readonly connected: boolean;
  readonly supported: boolean;
}): PreviewWorkspaceStatus {
  if (!options.supported) return "unsupported";
  if (!options.connected) return "offline";
  if (options.preview === undefined) return "empty";
  if (options.preview.freshness !== "fresh") {
    return "cached";
  }
  return options.preview.state ?? "ready";
}

export function previewActionSupport(
  preview: PreviewProjection | undefined,
  action: PreviewAction,
  status: PreviewWorkspaceStatus,
  controlSupported: boolean,
  inputSupported: boolean,
): PreviewActionSupport {
  if (status === "unsupported") {
    return { supported: false, reason: "This host does not advertise browser preview support." };
  }
  if (status === "offline") {
    return { supported: false, reason: "Preview actions are unavailable while this host is offline." };
  }
  if (status === "cached") {
    return { supported: false, reason: "Preview actions are unavailable until preview state is current." };
  }
  if (!controlSupported) {
    return { supported: false, reason: "This host does not permit browser preview control." };
  }
  if (status === "empty" || preview === undefined) {
    return { supported: false, reason: "Launch a preview before using this action." };
  }
  if (!controlSupported) {
    return { supported: false, reason: "This host does not permit browser preview control." };
  }
  if (["click", "fill", "type", "press", "scroll", "select", "upload"].includes(action) && !inputSupported) {
    return { supported: false, reason: "This host does not permit browser preview input." };
  }
  if (preview.availableActions?.includes(action) === true) return { supported: true };
  return { supported: false, reason: `This host does not advertise ${action} for this preview.` };
}

export function defaultLaunchAuthority(): "omp-session" {
  return "omp-session";
}

export function choosePreview(
  previews: readonly PreviewProjection[],
  selectedPreviewId: string | null,
  optIn: boolean,
  optInKind: string | null,
  optInAuthorityId: string | null,
): PreviewProjection | undefined {
  if (selectedPreviewId !== null) {
    const selected = previews.find((preview) => preview.previewId === selectedPreviewId);
    if (selected !== undefined) {
      const isDefaultSafe =
        selected.authority?.kind === "isolated-session" &&
        selected.authority.requiresExplicitOptIn === false;
      if (isDefaultSafe) {
        return selected;
      }
      const currentKind = selected.authority?.kind ?? null;
      const currentId = selected.authority?.id ?? null;
      if (optIn && currentKind === optInKind && currentId === optInAuthorityId) {
        return selected;
      }
    }
  }
  return previews.find(
    (preview) =>
      preview.authority?.kind === "isolated-session" &&
      preview.authority.requiresExplicitOptIn === false,
  );
}

export interface PreviewStateReconciliation {
  readonly selectedPreviewId: string | null;
  readonly previews: readonly PreviewProjection[];
}

export function reconcilePreviewState(
  state: PreviewStateReconciliation,
  clearPreview: () => void,
): void {
  if (
    state.selectedPreviewId !== null &&
    !state.previews.some((p) => p.previewId === state.selectedPreviewId)
  ) {
    clearPreview();
  }

}

export function previewTrustLabel(preview: PreviewProjection | undefined): string {
  if (preview?.authority === undefined) return "OMP session authority";
  if (preview.authority.kind === "authenticated-profile") {
    return `${preview.authority.label} — authenticated profile (explicit opt-in)`;
  }
  return `${preview.authority.label} — isolated session`;
}

export function isProjectRelativeUploadPath(path: string): boolean {
  const value = path.trim();
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

export function displayedToNativeCoordinate(
  point: { readonly x: number; readonly y: number },
  displayed: { readonly width: number; readonly height: number },
  native: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } | null {
  if (
    displayed.width <= 0 ||
    displayed.height <= 0 ||
    native.width <= 0 ||
    native.height <= 0 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(native.width - 1, Math.floor((point.x * native.width) / displayed.width))),
    y: Math.max(0, Math.min(native.height - 1, Math.floor((point.y * native.height) / displayed.height))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePreviewPolicyDecision(value: unknown): PreviewPolicyDecision {
  if (!isRecord(value)) {
    return { allowed: false, reason: "The host returned an invalid preview policy response." };
  }
  return {
    allowed: value.allowed === true,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}
