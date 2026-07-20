import { browserErrorMessage } from "@t4-code/client";
import {
  BROWSER_IPC_VERSION,
  type BrowserBounds,
  type BrowserCall,
  type BrowserConsoleMessage,
  type BrowserDownload,
  type BrowserEvent,
  type BrowserJsonValue,
  type BrowserMethod,
  type BrowserProfile,
  type BrowserRuntimeError,
  type OwnerSessionId,
  type BrowserSurfaceState,
  type SurfaceId,
} from "@t4-code/protocol/browser-ipc";

export const ISOLATED_BROWSER_PROFILE: BrowserProfile = Object.freeze({
  kind: "isolated-session",
  profileId: "isolated-session",
});

export const MAX_BROWSER_ADDRESS_LENGTH = 2_048;
export const MAX_BROWSER_EVAL_LENGTH = 8_192;
export const MAX_BROWSER_DESIGN_PROMPT_LENGTH = 2_048;
export const MAX_BROWSER_RESULT_LENGTH = 16_384;

const MAX_DOWNLOADS = 64;
const MAX_CONSOLE_MESSAGES = 100;
const MAX_RUNTIME_ERRORS = 50;
const SURFACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isSafeSurfaceId(value: unknown): value is SurfaceId {
  return typeof value === "string" && SURFACE_ID_PATTERN.test(value);
}


export interface BrowserProfileOption {
  readonly profileId: string;
  readonly label: string;
  readonly kind: BrowserProfile["kind"];
}

export interface BrowserWorkspaceModel {
  readonly surfaces: readonly BrowserSurfaceState[];
  readonly activeSurfaceId: SurfaceId | null;
  readonly downloads: readonly BrowserDownload[];
  readonly consoleMessages: readonly BrowserConsoleMessage[];
  readonly runtimeErrors: readonly BrowserRuntimeError[];
  /** Retained after close so an older state event cannot resurrect a tab. */
  readonly surfaceWatermarks: Readonly<Record<string, number>>;
}

export function initialBrowserWorkspaceModel(): BrowserWorkspaceModel {
  return {
    surfaces: [],
    activeSurfaceId: null,
    downloads: [],
    consoleMessages: [],
    runtimeErrors: [],
    surfaceWatermarks: {},
  };
}

export function browserCall(
  method: BrowserMethod,
  request: Readonly<Record<string, unknown>>,
  ownerSessionId: string,
): BrowserCall {
  return {
    version: BROWSER_IPC_VERSION,
    method,
    request: request as BrowserCall["request"],
    ownerSessionId: ownerSessionId as OwnerSessionId,
  };
}

export function liveBrowserSurfaces(
  model: Pick<BrowserWorkspaceModel, "surfaces">,
): readonly BrowserSurfaceState[] {
  return model.surfaces.filter((surface) => surface.lifecycle !== "closed");
}

function nextActiveSurfaceId(
  surfaces: readonly BrowserSurfaceState[],
  preferred: SurfaceId | null,
): SurfaceId | null {
  if (preferred === null) return null;
  const live = surfaces.filter((surface) => surface.lifecycle !== "closed");
  if (live.some((surface) => surface.surfaceId === preferred)) {
    return preferred;
  }
  return live.find((surface) => surface.visible)?.surfaceId ?? live.at(-1)?.surfaceId ?? null;
}

export function selectBrowserSurface(
  model: BrowserWorkspaceModel,
  surfaceId: SurfaceId | null,
): BrowserWorkspaceModel {
  return {
    ...model,
    activeSurfaceId: nextActiveSurfaceId(model.surfaces, surfaceId),
  };
}

export function reconcileBrowserSurfaces(
  model: BrowserWorkspaceModel,
  incoming: readonly BrowserSurfaceState[],
  preferredSurfaceId: SurfaceId | null = model.activeSurfaceId,
): BrowserWorkspaceModel {
  const byId = new Map(model.surfaces.map((surface) => [surface.surfaceId, surface]));
  const orderedIds: SurfaceId[] = [];
  const watermarks = { ...model.surfaceWatermarks };

  for (const surface of incoming) {
    const watermark = watermarks[surface.surfaceId] ?? -1;
    const current = byId.get(surface.surfaceId);
    if (surface.updatedAt < watermark || (current !== undefined && surface.updatedAt < current.updatedAt)) {
      continue;
    }
    byId.set(surface.surfaceId, surface);
    watermarks[surface.surfaceId] = Math.max(watermark, surface.updatedAt);
    orderedIds.push(surface.surfaceId);
  }

  // Preserve a state event that raced a list response. Closed entries are kept as
  // tombstones but filtered from the rendered tab order.
  for (const surface of model.surfaces) {
    if (!orderedIds.includes(surface.surfaceId)) orderedIds.push(surface.surfaceId);
  }

  const surfaces = orderedIds
    .map((surfaceId) => byId.get(surfaceId))
    .filter((surface): surface is BrowserSurfaceState => surface !== undefined);

  return {
    ...model,
    surfaces,
    activeSurfaceId: nextActiveSurfaceId(surfaces, preferredSurfaceId),
    surfaceWatermarks: watermarks,
  };
}

function upsertDownload(
  downloads: readonly BrowserDownload[],
  download: BrowserDownload,
): readonly BrowserDownload[] {
  return [download, ...downloads.filter((entry) => entry.downloadId !== download.downloadId)].slice(
    0,
    MAX_DOWNLOADS,
  );
}

export function applyBrowserEvent(
  model: BrowserWorkspaceModel,
  event: BrowserEvent,
): BrowserWorkspaceModel {
  if (event.type === "state") {
    const watermark = model.surfaceWatermarks[event.surface.surfaceId] ?? -1;
    if (event.surface.updatedAt < watermark) return model;
    const current = model.surfaces.find(
      (surface) => surface.surfaceId === event.surface.surfaceId,
    );
    if (current !== undefined && event.surface.updatedAt < current.updatedAt) return model;
    const surfaces = current === undefined
      ? [...model.surfaces, event.surface]
      : model.surfaces.map((surface) =>
          surface.surfaceId === event.surface.surfaceId ? event.surface : surface,
        );
    return {
      ...model,
      surfaces,
      activeSurfaceId: nextActiveSurfaceId(
        surfaces,
        event.surface.visible ? event.surface.surfaceId : model.activeSurfaceId,
      ),
      surfaceWatermarks: {
        ...model.surfaceWatermarks,
        [event.surface.surfaceId]: Math.max(watermark, event.surface.updatedAt),
      },
    };
  }

  const surfaceId =
    event.type === "download"
      ? event.download.surfaceId
      : event.type === "console"
        ? event.console.surfaceId
        : event.error.surfaceId;
  const live = model.surfaces.some(
    (surface) => surface.surfaceId === surfaceId && surface.lifecycle !== "closed",
  );
  if (!live) return model;

  if (event.type === "download") {
    return { ...model, downloads: upsertDownload(model.downloads, event.download) };
  }
  if (event.type === "console") {
    return {
      ...model,
      consoleMessages: [...model.consoleMessages, event.console].slice(-MAX_CONSOLE_MESSAGES),
    };
  }
  return {
    ...model,
    runtimeErrors: [...model.runtimeErrors, event.error].slice(-MAX_RUNTIME_ERRORS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function surfacesFromBrowserResult(value: unknown): readonly BrowserSurfaceState[] {
  if (!isRecord(value) || !Array.isArray(value.surfaces)) return [];
  return value.surfaces.filter(
    (surface): surface is BrowserSurfaceState =>
      isRecord(surface) &&
      isSafeSurfaceId(surface.surfaceId) &&
      typeof surface.updatedAt === "number" &&
      isRecord(surface.profile),
  );
}

export function surfaceFromBrowserResult(value: unknown): BrowserSurfaceState | null {
  if (!isRecord(value) || !isRecord(value.surface)) return null;
  const surface = value.surface;
  return isSafeSurfaceId(surface.surfaceId) &&
    typeof surface.updatedAt === "number" &&
    isRecord(surface.profile)
    ? (surface as unknown as BrowserSurfaceState)
    : null;
}

export function downloadsFromBrowserResult(value: unknown): readonly BrowserDownload[] {
  if (!isRecord(value) || !Array.isArray(value.downloads)) return [];
  return value.downloads.filter(
    (download): download is BrowserDownload =>
      isRecord(download) &&
      typeof download.downloadId === "string" &&
      isSafeSurfaceId(download.surfaceId),
  );
}

export function consoleFromBrowserResult(value: unknown): readonly BrowserConsoleMessage[] {
  if (!isRecord(value)) return [];
  const messages = Array.isArray(value.messages)
    ? value.messages
    : Array.isArray(value.console)
      ? value.console
      : [];
  return messages.filter(
    (message): message is BrowserConsoleMessage =>
      isRecord(message) &&
      isSafeSurfaceId(message.surfaceId) &&
      typeof message.message === "string",
  );
}

export function errorsFromBrowserResult(value: unknown): readonly BrowserRuntimeError[] {
  if (!isRecord(value) || !Array.isArray(value.errors)) return [];
  return value.errors.filter(
    (error): error is BrowserRuntimeError =>
      isRecord(error) &&
      isSafeSurfaceId(error.surfaceId) &&
      typeof error.message === "string",
  );
}

export function profileOptionsFromBrowserResult(value: unknown): readonly BrowserProfileOption[] {
  const raw = isRecord(value) && Array.isArray(value.profiles) ? value.profiles : [];
  const options: BrowserProfileOption[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.profileId !== "string" ||
      typeof entry.label !== "string" ||
      (entry.kind !== "isolated-session" && entry.kind !== "authenticated-profile")
    ) {
      continue;
    }
    options.push({
      profileId: entry.profileId,
      label: entry.label,
      kind: entry.kind,
    });
  }
  if (!options.some((option) => option.kind === "isolated-session")) {
    options.unshift({
      profileId: ISOLATED_BROWSER_PROFILE.profileId,
      label: "OMP session",
      kind: "isolated-session",
    });
  }
  return options.slice(0, 64);
}

export function browserProfileFromOption(option: BrowserProfileOption): BrowserProfile {
  return option.kind === "isolated-session"
    ? ISOLATED_BROWSER_PROFILE
    : {
        kind: "authenticated-profile",
        profileId: option.profileId,
        explicitOptIn: true,
      };
}

export function browserProfileTrustLabel(profile: BrowserProfile): string {
  return profile.kind === "isolated-session"
    ? "Isolated · session-only data"
    : "Authenticated · can access signed-in sites";
}

export function normalizeBrowserAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "about:blank";
  if (trimmed.length > MAX_BROWSER_ADDRESS_LENGTH) {
    throw new Error("The address is too long.");
  }
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid web address.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "about:") ||
    (parsed.protocol === "about:" && parsed.href !== "about:blank")
  ) {
    throw new Error("Only HTTP and HTTPS addresses are supported.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Addresses containing credentials are not allowed.");
  }
  return parsed.toString();
}

export function nativeBoundsFromRect(
  rect: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">,
  viewport: { readonly width: number; readonly height: number },
): BrowserBounds | null {
  const left = Math.max(0, Math.ceil(rect.left));
  const top = Math.max(0, Math.ceil(rect.top));
  const right = Math.min(Math.floor(viewport.width), Math.floor(rect.right));
  const bottom = Math.min(Math.floor(viewport.height), Math.floor(rect.bottom));
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { x: left, y: top, width, height } : null;
}

function sanitizedError(error: unknown): { code: string; message: string } {
  if (isRecord(error)) {
    const nested = isRecord(error.error) ? error.error : error;
    if (typeof nested.message === "string") {
      return {
        code: typeof nested.code === "string" ? nested.code : "internal",
        message: nested.message,
      };
    }
  }
  if (error instanceof Error) return { code: "internal", message: error.message };
  return { code: "internal", message: "Browser operation failed" };
}

export function safeBrowserActionError(error: unknown): string {
  return browserErrorMessage(sanitizedError(error) as Parameters<typeof browserErrorMessage>[0]);
}

function jsonReplacer(_key: string, value: unknown): BrowserJsonValue | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return undefined;
  }
  return value as BrowserJsonValue;
}

export function formatBrowserResult(value: unknown): string {
  let result: string;
  try {
    result = JSON.stringify(value, jsonReplacer, 2) ?? String(value);
  } catch {
    result = "Result could not be displayed.";
  }
  if (result.length <= MAX_BROWSER_RESULT_LENGTH) return result;
  return `${result.slice(0, MAX_BROWSER_RESULT_LENGTH)}\n… result truncated`;
}
