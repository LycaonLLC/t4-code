import { controlFree } from "@oh-my-pi/app-wire";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "manual"
  | "downloading"
  | "ready"
  | "error";

/** Renderer-safe update metadata. Download URLs and filesystem paths stay in Electron main. */
export interface DesktopUpdateState {
  readonly version: 1;
  readonly currentVersion: string;
  readonly phase: DesktopUpdatePhase;
  readonly checkedAt?: number;
  readonly availableVersion?: string;
  readonly progressPercent?: number;
  readonly message?: string;
}

export type AndroidUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installer"
  | "error";

/** Renderer-safe payload emitted by the Capacitor Android update plugin. */
export interface AndroidUpdateState {
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly checkedAt?: number;
  readonly phase: AndroidUpdatePhase;
  readonly revision: number;
  readonly error?: string;
  readonly message?: string;
}

const DESKTOP_VERSION_PATTERN =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?)?$/u;
const ANDROID_VERSION_PATTERN =
  /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("unknown key");
}

function version(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function displayText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`invalid ${name}`);
  const cleaned = Array.from(value)
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ? " " : character;
    })
    .join("")
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, 512);
}

/** Strictly decode and freeze update state before it crosses either Electron IPC boundary. */
export function decodeDesktopUpdateState(value: unknown): DesktopUpdateState {
  const item = record(value, "desktop update state");
  exact(item, [
    "version",
    "currentVersion",
    "phase",
    "checkedAt",
    "availableVersion",
    "progressPercent",
    "message",
  ]);
  if (item.version !== 1) throw new Error("unsupported desktop update state");
  if (
    ![
      "idle",
      "checking",
      "current",
      "available",
      "manual",
      "downloading",
      "ready",
      "error",
    ].includes(item.phase as string)
  ) {
    throw new Error("invalid desktop update phase");
  }
  if (
    item.progressPercent !== undefined &&
    (typeof item.progressPercent !== "number" ||
      !Number.isFinite(item.progressPercent) ||
      item.progressPercent < 0 ||
      item.progressPercent > 100)
  ) {
    throw new Error("invalid desktop update progress");
  }
  const checkedAt = timestamp(item.checkedAt, "desktop update checkedAt");
  const message =
    item.message === undefined ? undefined : controlFree(item.message, "message", 512);
  const decoded: DesktopUpdateState = {
    version: 1,
    currentVersion: version(item.currentVersion, "currentVersion", DESKTOP_VERSION_PATTERN),
    phase: item.phase as DesktopUpdatePhase,
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(item.availableVersion === undefined
      ? {}
      : {
          availableVersion: version(
            item.availableVersion,
            "availableVersion",
            DESKTOP_VERSION_PATTERN,
          ),
        }),
    ...(item.progressPercent === undefined ? {} : { progressPercent: item.progressPercent }),
    ...(message === undefined ? {} : { message }),
  };
  return Object.freeze(decoded);
}

/** Strictly decode and freeze the untrusted value returned by the Capacitor bridge. */
export function decodeAndroidUpdateState(value: unknown): AndroidUpdateState {
  const item = record(value, "Android update state");
  exact(item, [
    "currentVersion",
    "latestVersion",
    "checkedAt",
    "phase",
    "revision",
    "error",
    "message",
  ]);
  if (
    !["idle", "checking", "current", "available", "downloading", "installer", "error"].includes(
      item.phase as string,
    )
  ) {
    throw new Error("invalid Android updater phase");
  }
  if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 0) {
    throw new Error("invalid Android updater revision");
  }
  const checkedAt = timestamp(item.checkedAt, "Android updater checkedAt");
  const error = displayText(item.error, "Android updater error");
  const message = displayText(item.message, "Android updater message");
  const decoded: AndroidUpdateState = {
    currentVersion: version(item.currentVersion, "currentVersion", ANDROID_VERSION_PATTERN),
    phase: item.phase as AndroidUpdatePhase,
    revision: item.revision,
    ...(item.latestVersion === undefined
      ? {}
      : { latestVersion: version(item.latestVersion, "latestVersion", ANDROID_VERSION_PATTERN) }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(error === undefined ? {} : { error }),
    ...(message === undefined ? {} : { message }),
  };
  return Object.freeze(decoded);
}
