import ElectronStore from "electron-store";
import {
  isBrowserOwnerSessionId,
  type BrowserProfile,
  type SurfaceHandle,
  type SurfaceId,
} from "@t4-code/protocol/browser-ipc";

export const BROWSER_SESSION_STORE_VERSION = 2 as const;
export const MAX_BROWSER_SESSIONS = 64;
const MAX_SURFACE_ID_BYTES = 64;
const MAX_SURFACE_HANDLE_BYTES = 32;
const MAX_URL_BYTES = 8_192;
const MAX_ORDER = 100_000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const SURFACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SURFACE_HANDLE_PATTERN = /^surface:[1-9][0-9]{0,8}$/u;
const SENSITIVE_QUERY_KEY = /(?:token|secret|password|passwd|credential|authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session|cookie|code)/iu;

export interface BrowserSessionMetadata {
  readonly surfaceId: SurfaceId;
  readonly handle: SurfaceHandle;
  /** Durable workspace-session owner. Records without this field are legacy and ignored. */
  readonly ownerSessionId: string;
  readonly profile: BrowserProfile;
  readonly url: string;
  readonly order: number;
  readonly zoom: number;
}

export interface BrowserSessionStoreState {
  readonly version: 2;
  readonly surfaces: readonly BrowserSessionMetadata[];
}

export interface BrowserSessionStoreBackend {
  readonly store: unknown;
  set(key: string, value: unknown): void;
}

export interface BrowserSessionStoreOptions {
  readonly userDataPath?: string;
  readonly store?: BrowserSessionStoreBackend;
}

function emptyState(): BrowserSessionStoreState {
  return { version: BROWSER_SESSION_STORE_VERSION, surfaces: [] };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function replaceControlCharacters(value: string, replacement: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    result += codePoint !== undefined && (codePoint <= 0x1F || codePoint === 0x7F || (codePoint >= 0x80 && codePoint <= 0x9F)) ? replacement : character;
  }
  return result;
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let result = replaceControlCharacters(value.normalize("NFKC"), " ").trim();
  while (utf8Length(result) > maxBytes) result = result.slice(0, Math.max(1, result.length - 1));
  return result.length === 0 ? undefined : result;
}

/**
 * Keeps only a navigation URL that is safe to restore. Temporary document URLs
 * and credential-bearing URLs become about:blank; fragments and known secret
 * query parameters are never written to disk.
 */
export function sanitizeBrowserNavigationUrl(value: unknown): string {
  const candidate = boundedString(value, MAX_URL_BYTES);
  if (candidate === undefined) return "about:blank";
  if (candidate.toLowerCase() === "about:blank") return "about:blank";
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { return "about:blank"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "about:blank";
  if (parsed.username !== "" || parsed.password !== "") return "about:blank";
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  const result = parsed.toString();
  return utf8Length(result) <= MAX_URL_BYTES ? result : "about:blank";
}

function safeSurfaceId(value: unknown): SurfaceId | undefined {
  const result = boundedString(value, MAX_SURFACE_ID_BYTES);
  return result !== undefined && SURFACE_ID_PATTERN.test(result) ? result as SurfaceId : undefined;
}

function safeSurfaceHandle(value: unknown): SurfaceHandle | undefined {
  const result = boundedString(value, MAX_SURFACE_HANDLE_BYTES);
  return result !== undefined && SURFACE_HANDLE_PATTERN.test(result) ? result as SurfaceHandle : undefined;
}

function safeOwnerSessionId(value: unknown): string | undefined {
  return isBrowserOwnerSessionId(value) ? value : undefined;
}

function safeProfile(value: unknown): BrowserProfile | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profile = value as Record<string, unknown>;
  if (profile.kind === "isolated-session" && profile.profileId === "isolated-session" && Object.keys(profile).every((key) => key === "kind" || key === "profileId")) {
    return { kind: "isolated-session", profileId: "isolated-session" };
  }
  if (profile.kind === "authenticated-profile" && profile.explicitOptIn === true && typeof profile.profileId === "string") {
    const profileId = boundedString(profile.profileId, 96);
    if (profileId !== undefined && /^[a-z][a-z0-9._-]{0,63}$/u.test(profileId) && !["default", "session"].includes(profileId)) {
      return { kind: "authenticated-profile", profileId, explicitOptIn: true };
    }
  }
  return undefined;
}

function normalizeRecord(value: unknown): BrowserSessionMetadata | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const surfaceId = safeSurfaceId(input.surfaceId);
  const handle = safeSurfaceHandle(input.handle);
  const ownerSessionId = safeOwnerSessionId(input.ownerSessionId);
  const profile = safeProfile(input.profile);
  if (surfaceId === undefined || handle === undefined || ownerSessionId === undefined || profile === undefined) return undefined;
  const order = typeof input.order === "number" && Number.isSafeInteger(input.order) && input.order >= 0 && input.order <= MAX_ORDER ? input.order : undefined;
  const zoom = typeof input.zoom === "number" && Number.isFinite(input.zoom) && input.zoom >= MIN_ZOOM && input.zoom <= MAX_ZOOM ? input.zoom : undefined;
  if (order === undefined || zoom === undefined) return undefined;
  return { surfaceId, handle, ownerSessionId, profile, url: sanitizeBrowserNavigationUrl(input.url), order, zoom };
}

function decodeState(value: unknown): BrowserSessionStoreState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid browser session state");
  const root = value as Record<string, unknown>;
  if (root.version !== BROWSER_SESSION_STORE_VERSION || !Array.isArray(root.surfaces) || root.surfaces.length > MAX_BROWSER_SESSIONS) throw new Error("invalid browser session state");
  const surfaces: BrowserSessionMetadata[] = [];
  const surfaceIds = new Set<SurfaceId>();
  const handles = new Set<SurfaceHandle>();
  for (const item of root.surfaces) {
    // Legacy records used a runtime-generated sessionId and cannot be safely
    // assigned to a durable workspace owner. Drop them rather than restoring them.
    if (item !== null && typeof item === "object" && !Array.isArray(item) && !("ownerSessionId" in item)) continue;
    const record = normalizeRecord(item);
    if (record === undefined || surfaceIds.has(record.surfaceId) || handles.has(record.handle)) throw new Error("invalid browser session record");
    surfaceIds.add(record.surfaceId);
    handles.add(record.handle);
    surfaces.push(record);
  }
  return { version: BROWSER_SESSION_STORE_VERSION, surfaces };
}
export function decodeBrowserSessionStoreState(value: unknown): BrowserSessionStoreState {
  try { return decodeState(value); } catch { return emptyState(); }
}

function enqueue<T>(queue: { tail: Promise<void> }, operation: () => T | Promise<T>): Promise<T> {
  const result = queue.tail.then(operation, operation);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

/** Persists only bounded, restorable browser layout/navigation metadata. */
export class BrowserSessionStore {
  private readonly store: BrowserSessionStoreBackend;
  private readonly writeQueue = { tail: Promise.resolve() };
  private state: BrowserSessionStoreState;

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.store = options.store ?? new ElectronStore<BrowserSessionStoreState>({
      name: "browser-session-store",
      ...(options.userDataPath === undefined ? {} : { cwd: options.userDataPath }),
      defaults: emptyState(),
    });
    this.state = this.readState();
  }

  load(): readonly BrowserSessionMetadata[] {
    this.state = this.readState();
    return this.state.surfaces.map((record) => ({ ...record, profile: { ...record.profile } }));
  }

  read(): readonly BrowserSessionMetadata[] { return this.load(); }

  save(value: unknown): Promise<void> {
    return this.write(value);
  }

  write(value: unknown): Promise<void> {
    const records = Array.isArray(value) ? value : [value];
    return enqueue(this.writeQueue, () => {
      const normalized = records.map(normalizeRecord).filter((record): record is BrowserSessionMetadata => record !== undefined);
      const surfaceIds = new Set<SurfaceId>();
      const handles = new Set<SurfaceHandle>();
      const unique = normalized.filter((record) => {
        if (surfaceIds.has(record.surfaceId) || handles.has(record.handle)) return false;
        surfaceIds.add(record.surfaceId);
        handles.add(record.handle);
        return true;
      }).slice(0, MAX_BROWSER_SESSIONS);
      const next: BrowserSessionStoreState = { version: BROWSER_SESSION_STORE_VERSION, surfaces: unique };
      this.store.set("version", next.version);
      this.store.set("surfaces", next.surfaces);
      this.state = next;
    });
  }

  upsert(value: BrowserSessionMetadata): Promise<void> {
    const record = normalizeRecord(value);
    if (record === undefined) return Promise.reject(new Error("invalid browser session metadata"));
    return enqueue(this.writeQueue, () => {
      const records = this.state.surfaces.filter((item) => item.surfaceId !== record.surfaceId);
      if (records.some((item) => item.handle === record.handle)) throw new Error("browser surface handle is already in use");
      records.push(record);
      records.sort((left, right) => left.order - right.order);
      const next: BrowserSessionStoreState = { version: BROWSER_SESSION_STORE_VERSION, surfaces: records.slice(0, MAX_BROWSER_SESSIONS) };
      this.store.set("version", next.version);
      this.store.set("surfaces", next.surfaces);
      this.state = next;
    });
  }

  remove(surfaceId: string): Promise<void> {
    return enqueue(this.writeQueue, () => {
      const next: BrowserSessionStoreState = {
        version: BROWSER_SESSION_STORE_VERSION,
        surfaces: this.state.surfaces.filter((record) => record.surfaceId !== surfaceId),
      };
      this.store.set("version", next.version);
      this.store.set("surfaces", next.surfaces);
      this.state = next;
    });
  }

  clear(): Promise<void> {
    return enqueue(this.writeQueue, () => {
      const next = emptyState();
      this.store.set("version", next.version);
      this.store.set("surfaces", next.surfaces);
      this.state = next;
    });
  }

  private readState(): BrowserSessionStoreState {
    try {
      const state = decodeState(this.store.store);
      return state;
    } catch {
      const state = emptyState();
      try { this.store.set("version", state.version); this.store.set("surfaces", state.surfaces); } catch { /* best effort recovery */ }
      return state;
    }
  }
}

export function normalizeBrowserSessionMetadata(value: unknown): BrowserSessionMetadata | undefined {
  return normalizeRecord(value);
}
