import ElectronStore from "electron-store";
import { createHash } from "node:crypto";
import { session as electronSession, type Session } from "electron";
import type { BrowserProfile } from "@t4-code/protocol/browser-ipc";

export const BROWSER_ISOLATED_PROFILE_ID = "isolated-session" as const;
export const BROWSER_ISOLATED_PARTITION = "browser-isolated-session" as const;
export const BROWSER_PROFILE_STORE_VERSION = 1 as const;

const MAX_PROFILES = 64;
const MAX_ID_BYTES = 96;
const MAX_LABEL_BYTES = 128;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const RESERVED_PROFILE_IDS = new Set([BROWSER_ISOLATED_PROFILE_ID, "default", "session"]);

export interface BrowserProfileMetadata {
  readonly profileId: string;
  readonly label: string;
  readonly partition: string;
  readonly kind: "isolated-session" | "authenticated-profile";
  readonly explicitOptIn?: true;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BrowserProfileStoreRecord {
  readonly profileId: string;
  readonly label: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BrowserProfileStoreState {
  readonly version: 1;
  readonly records: readonly BrowserProfileStoreRecord[];
}

export interface BrowserProfileRegistryStore {
  readonly store: unknown;
  set(key: string, value: unknown): void;
}

export interface BrowserSessionProvider {
  fromPartition(partition: string, options?: { readonly cache?: boolean }): Session;
}

export interface BrowserProfileRegistryOptions {
  readonly userDataPath?: string;
  readonly store?: BrowserProfileRegistryStore;
  readonly session?: BrowserSessionProvider;
  readonly now?: () => number;
}

export interface BrowserProfileCreateOptions {
  readonly profileId?: string;
  readonly label?: string;
}

export interface BrowserProfileDeleteOptions {
  readonly inUse?: boolean;
}

const DEFAULT_LABEL = "OMP session";

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

function boundedText(value: unknown, fallback: string, maxBytes: number): string {
  if (typeof value !== "string") return fallback;
  let result = replaceControlCharacters(value.normalize("NFKC"), " ").trim();
  if (result.length === 0) return fallback;
  while (utf8Length(result) > maxBytes) result = result.slice(0, Math.max(1, result.length - 1));
  return result || fallback;
}

/** Produces a stable, non-secret identifier suitable for a persistent Electron partition. */
export function sanitizeBrowserProfileId(value: unknown, fallback = "profile"): string {
  let source = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  source = source.replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z]+/u, "").replace(/-{2,}/gu, "-");
  source = source.replace(/[-_.]+$/u, "");
  if (source.length === 0) source = fallback;
  source = boundedText(source, fallback, MAX_ID_BYTES).slice(0, 64);
  if (!/^[a-z]/u.test(source)) source = `profile-${source}`;
  if (!PROFILE_ID_PATTERN.test(source) || RESERVED_PROFILE_IDS.has(source)) {
    source = boundedText(fallback, "profile", MAX_ID_BYTES).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
    source = source.replace(/^[^a-z]+/u, "").replace(/[-_.]+$/u, "").slice(0, 64);
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(source) || RESERVED_PROFILE_IDS.has(source)) source = "profile";
  }
  return source;
}

export function sanitizeBrowserProfileLabel(value: unknown, fallback = "Profile"): string {
  return boundedText(value, fallback, MAX_LABEL_BYTES).slice(0, 128);
}

function profilePartition(profileId: string): string {
  return `persist:browser-profile-${profileId}`;
}

function isolatedPartition(ownerSessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(ownerSessionId)) {
    throw new Error("an owning OMP session is required for isolated browser state");
  }
  // Partition names are observable in Electron diagnostics. Hash the durable
  // OMP session id so browser isolation does not disclose the session id.
  const ownerHash = createHash("sha256").update(ownerSessionId, "utf8").digest("hex").slice(0, 32);
  return `${BROWSER_ISOLATED_PARTITION}-${ownerHash}`;
}

function metadataForRecord(record: BrowserProfileStoreRecord): BrowserProfileMetadata {
  return {
    profileId: record.profileId,
    label: record.label,
    partition: profilePartition(record.profileId),
    kind: "authenticated-profile",
    explicitOptIn: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function profileForMetadata(metadata: BrowserProfileMetadata): BrowserProfile {
  return metadata.kind === "isolated-session"
    ? { kind: "isolated-session", profileId: BROWSER_ISOLATED_PROFILE_ID }
    : { kind: "authenticated-profile", profileId: metadata.profileId, explicitOptIn: true };
}

function emptyState(): BrowserProfileStoreState {
  return { version: BROWSER_PROFILE_STORE_VERSION, records: [] };
}

function decodeState(value: unknown): BrowserProfileStoreState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid browser profile state");
  const root = value as Record<string, unknown>;
  if (root.version !== BROWSER_PROFILE_STORE_VERSION || !Array.isArray(root.records)) throw new Error("invalid browser profile state");
  const records: BrowserProfileStoreRecord[] = [];
  const seen = new Set<string>();
  for (const item of root.records) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid browser profile record");
    const record = item as Record<string, unknown>;
    if (typeof record.profileId !== "string" || typeof record.label !== "string" || Object.keys(record).some((key) => !["profileId", "label", "createdAt", "updatedAt"].includes(key))) throw new Error("invalid browser profile record");
    const profileId = sanitizeBrowserProfileId(record.profileId, "");
    if (profileId !== record.profileId || !PROFILE_ID_PATTERN.test(profileId) || RESERVED_PROFILE_IDS.has(profileId) || seen.has(profileId)) throw new Error("invalid browser profile id");
    const label = sanitizeBrowserProfileLabel(record.label, "Profile");
    if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) throw new Error("invalid browser profile timestamps");
    seen.add(profileId);
    records.push({ profileId, label, createdAt: record.createdAt, updatedAt: record.updatedAt });
    if (records.length > MAX_PROFILES) throw new Error("too many browser profiles");
  }
  return { version: 1, records };
}
export function decodeBrowserProfileStoreState(value: unknown): BrowserProfileStoreState {
  try { return decodeState(value); } catch { return emptyState(); }
}


const isolatedMetadata: BrowserProfileMetadata = Object.freeze({
  profileId: BROWSER_ISOLATED_PROFILE_ID,
  label: DEFAULT_LABEL,
  partition: BROWSER_ISOLATED_PARTITION,
  kind: "isolated-session",
  createdAt: 0,
  updatedAt: 0,
});

/** Owns the safe profile catalogue and maps each profile to an isolated Electron partition. */
export class BrowserProfileRegistry {
  private readonly store: BrowserProfileRegistryStore;
  private readonly sessions: BrowserSessionProvider;
  private readonly now: () => number;
  private readonly activeProfileCounts = new Map<string, number>();
  private state: BrowserProfileStoreState;

  constructor(options: BrowserProfileRegistryOptions = {}) {
    this.store = options.store ?? new ElectronStore<BrowserProfileStoreState>({
      name: "browser-profiles",
      ...(options.userDataPath === undefined ? {} : { cwd: options.userDataPath }),
      defaults: emptyState(),
    });
    this.sessions = options.session ?? electronSession;
    this.now = options.now ?? Date.now;
    this.state = this.readState();
  }

  /** Lists the built-in isolated profile and persisted authenticated profile metadata. */
  list(): readonly BrowserProfileMetadata[] {
    return [isolatedMetadata, ...this.state.records.map(metadataForRecord)];
  }

  listProfiles(): readonly BrowserProfileMetadata[] { return this.list(); }

  /** Resolves only an exact authenticated id; an omitted id always resolves to isolation. */
  resolve(profileId?: string | null): BrowserProfileMetadata {
    if (profileId === undefined || profileId === null || profileId === "") return isolatedMetadata;
    const exact = this.state.records.find((record) => record.profileId === profileId);
    if (exact === undefined) throw new Error("authenticated browser profile was not found");
    return metadataForRecord(exact);
  }

  get(profileId?: string | null): BrowserProfileMetadata { return this.resolve(profileId); }

  profile(profileId?: string | null): BrowserProfile { return profileForMetadata(this.resolve(profileId)); }

  getProfile(profileId?: string | null): BrowserProfile { return this.profile(profileId); }

  getPartition(profileId?: string | null, ownerSessionId?: string): string {
    const metadata = this.resolve(profileId);
    return metadata.kind === "isolated-session"
      ? isolatedPartition(ownerSessionId ?? "")
      : metadata.partition;
  }
  /** Returns a profile session; isolated state is scoped to one owning OMP session. */
  getSession(
    profile: BrowserProfile | string | null | undefined = undefined,
    ownerSessionId?: string,
  ): Session {
    const profileId = typeof profile === "string"
      ? profile
      : profile?.kind === "authenticated-profile" ? profile.profileId : undefined;
    const metadata = this.resolve(profileId);
    if (profile !== undefined && profile !== null && typeof profile !== "string" && profile.kind === "authenticated-profile" && profile.explicitOptIn !== true) {
      throw new Error("authenticated browser profile requires explicit opt-in");
    }
    const partition = metadata.kind === "isolated-session"
      ? isolatedPartition(ownerSessionId ?? "")
      : metadata.partition;
    return this.sessions.fromPartition(partition, { cache: metadata.kind === "authenticated-profile" });
  }

  create(options: BrowserProfileCreateOptions = {}): BrowserProfileMetadata {
    if (this.state.records.length >= MAX_PROFILES) throw new Error("browser profile limit reached");
    const base = sanitizeBrowserProfileId(options.profileId ?? options.label ?? "profile");
    let profileId = base;
    let suffix = 2;
    while (this.state.records.some((record) => record.profileId === profileId) || RESERVED_PROFILE_IDS.has(profileId)) {
      profileId = `${base}-${suffix}`.slice(0, 64);
      suffix += 1;
      if (suffix > 10_000) throw new Error("could not allocate browser profile id");
    }
    const timestamp = this.now();
    const record: BrowserProfileStoreRecord = {
      profileId,
      label: sanitizeBrowserProfileLabel(options.label, profileId),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state = { version: 1, records: [...this.state.records, record] };
    this.persist(this.state);
    return metadataForRecord(record);
  }

  rename(profileId: string, label: string): BrowserProfileMetadata {
    const exact = this.state.records.find((record) => record.profileId === profileId);
    if (exact === undefined) throw new Error("authenticated browser profile was not found");
    const record = { ...exact, label: sanitizeBrowserProfileLabel(label, exact.label), updatedAt: this.now() };
    this.state = { version: 1, records: this.state.records.map((item) => item.profileId === profileId ? record : item) };
    this.persist(this.state);
    return metadataForRecord(record);
  }

  async clear(profileId: string): Promise<void> {
    const metadata = this.requireAuthenticated(profileId);
    const profileSession = this.getSession(profileForMetadata(metadata));
    await profileSession.clearStorageData();
    await profileSession.clearCache();
  }

  async delete(profileId: string, options: BrowserProfileDeleteOptions | boolean = {}): Promise<boolean> {
    this.requireAuthenticated(profileId);
    const inUse = typeof options === "boolean" ? options : options.inUse === true;
    if (inUse || (this.activeProfileCounts.get(profileId) ?? 0) > 0) throw new Error("browser profile is in use");
    await this.clear(profileId);
    this.state = { version: 1, records: this.state.records.filter((record) => record.profileId !== profileId) };
    await this.persist(this.state);
    return true;
  }

  markInUse(profileId: string): void {
    if (profileId === BROWSER_ISOLATED_PROFILE_ID) return;
    this.requireAuthenticated(profileId);
    this.activeProfileCounts.set(profileId, (this.activeProfileCounts.get(profileId) ?? 0) + 1);
  }
  release(profileId: string): void {
    if (profileId === BROWSER_ISOLATED_PROFILE_ID) return;
    const count = this.activeProfileCounts.get(profileId) ?? 0;
    if (count <= 1) this.activeProfileCounts.delete(profileId);
    else this.activeProfileCounts.set(profileId, count - 1);
  }
  isInUse(profileId: string): boolean { return (this.activeProfileCounts.get(profileId) ?? 0) > 0; }

  /** Acquires a deletion guard for a profile and releases it when the returned callback runs. */
  acquire(profileId: string): () => void {
    this.markInUse(profileId);
    return () => this.release(profileId);
  }

  private requireAuthenticated(profileId: string): BrowserProfileMetadata {
    if (profileId === BROWSER_ISOLATED_PROFILE_ID || profileId === "default" || profileId === "session") throw new Error("the isolated browser profile cannot be changed");
    const metadata = this.resolve(profileId);
    if (metadata.kind !== "authenticated-profile") throw new Error("an authenticated browser profile is required");
    return metadata;
  }

  private readState(): BrowserProfileStoreState {
    try {
      const value = this.store.store;
      const state = decodeState(value);
      return state;
    } catch {
      const state = emptyState();
      try { this.store.set("version", state.version); this.store.set("records", state.records); } catch { /* best effort recovery */ }
      return state;
    }
  }

  private persist(state: BrowserProfileStoreState): Promise<void> {
    const decoded = decodeState(state);
    this.store.set("version", decoded.version);
    this.store.set("records", decoded.records);
    return Promise.resolve();
  }

}

export function browserProfileToProtocol(metadata: BrowserProfileMetadata): BrowserProfile {
  return profileForMetadata(metadata);
}
