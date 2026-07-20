import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Session } from "electron";
import type { BrowserProfile } from "@t4-code/protocol/browser-ipc";
import {
  BrowserProfileRegistry,
  browserProfileToProtocol,
  type BrowserProfileCreateOptions,
  type BrowserProfileMetadata,
} from "./browser-profiles.ts";

const MAX_FILE_PATH_BYTES = 4_096;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_COOKIES = 2_048;
const MAX_COOKIE_NAME_BYTES = 256;
const MAX_COOKIE_VALUE_BYTES = 16_384;
const MAX_COOKIE_DOMAIN_BYTES = 512;
const MAX_COOKIE_PATH_BYTES = 512;
const MAX_LABEL_BYTES = 128;
const MAX_PROFILE_ID_BYTES = 96;

type ProfileErrorCode = "invalid_params" | "not_found" | "invalid_state" | "security" | "not_supported" | "internal";

export interface BrowserProfileAutomationFailure {
  readonly ok: false;
  readonly code: ProfileErrorCode;
  readonly message: string;
  readonly reason: string;
}

export interface BrowserProfileAutomationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type BrowserProfileAutomationResult<T> = BrowserProfileAutomationSuccess<T> | BrowserProfileAutomationFailure;

export interface BrowserProfileAutomationOptions {
  readonly registry: BrowserProfileRegistry;
  readonly readFile?: (path: string) => Promise<string>;
}

export interface BrowserProfileSelectionRequest {
  readonly profileId: string;
  readonly profile?: BrowserProfile;
}

export interface BrowserCookieImportRequest extends BrowserProfileSelectionRequest {
  /** A path explicitly selected by the user; this module never discovers browser data. */
  readonly filePath: string;
}

export interface BrowserCookieImportResult {
  readonly profileId: string;
  readonly imported: number;
  readonly selected: false;
}

export interface BrowserProfileMutationResult {
  readonly profile: BrowserProfileMetadata;
}

export interface BrowserProfileClearResult {
  readonly profileId: string;
  readonly cleared: true;
}

export interface BrowserProfileDeleteResult {
  readonly profileId: string;
  readonly deleted: true;
}


interface ElectronCookieDetails {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly expirationDate?: number;
  readonly sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

interface CookieStoreLike {
  set(details: ElectronCookieDetails): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCookieStore(value: unknown): value is CookieStoreLike {
  return value !== null && typeof value === "object" && "set" in value && typeof value.set === "function";
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function replaceControlCharacters(value: string, replacement: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    result += codePoint !== undefined && (codePoint <= 0x1F || codePoint === 0x7F || (codePoint >= 0x80 && codePoint <= 0x9F)) ? replacement : character;
  }
  return result;
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let result = replaceControlCharacters(value.normalize("NFKC"), " ").trim();
  if (result.length === 0) return undefined;
  while (byteLength(result) > maxBytes) result = result.slice(0, Math.max(1, result.length - 1));
  return byteLength(result) <= maxBytes ? result : undefined;
}

function failure(code: ProfileErrorCode, reason: string): BrowserProfileAutomationFailure {
  const safeReason = boundedString(reason, 2_048) ?? "profile operation failed";
  return { ok: false, code, reason: safeReason, message: safeReason };
}

function success<T>(value: T): BrowserProfileAutomationSuccess<T> { return { ok: true, value }; }

function profileId(value: unknown): string | undefined {
  const result = boundedString(value, MAX_PROFILE_ID_BYTES);
  return result !== undefined && /^[a-z][a-z0-9._-]{0,63}$/u.test(result) ? result : undefined;
}

function profileLabel(value: unknown): string | undefined {
  return boundedString(value, MAX_LABEL_BYTES);
}

function selectedProfile(value: unknown): { readonly profileId: string; readonly profile?: BrowserProfile } | BrowserProfileAutomationFailure {
  if (!isRecord(value)) return failure("security", "an exact browser profile selection is required");
  const id = profileId(value.profileId);
  if (id === undefined) return failure("security", "an exact browser profile selection is required");
  const profile = value.profile;
  if (id === "isolated-session") {
    if (profile === undefined) return { profileId: id };
    if (!isRecord(profile) || profile.kind !== "isolated-session" || profile.profileId !== "isolated-session" || Object.keys(profile).some((key) => key !== "kind" && key !== "profileId")) {
      return failure("security", "browser profile selection was not exact");
    }
    return { profileId: id, profile: { kind: "isolated-session", profileId: "isolated-session" } };
  }
  if (!isRecord(profile) || profile.kind !== "authenticated-profile" || profile.profileId !== id || profile.explicitOptIn !== true || Object.keys(profile).some((key) => key !== "kind" && key !== "profileId" && key !== "explicitOptIn")) {
    return failure("security", "authenticated browser profiles require exact explicit selection");
  }
  return { profileId: id, profile: { kind: "authenticated-profile", profileId: id, explicitOptIn: true } };
}

function safeCookieDomain(value: unknown): string | undefined {
  const domain = boundedString(value, MAX_COOKIE_DOMAIN_BYTES)?.toLowerCase();
  if (domain === undefined || domain.length > 253 || domain.includes("/") || domain.includes("\\") || domain.includes(":") || domain.includes("@") || domain.startsWith(".")) {
    if (domain === undefined || domain.length === 0 || !domain.startsWith(".")) return undefined;
  }
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  if (host.length === 0 || host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) return undefined;
  return domain;
}

function safeCookiePath(value: unknown): string | undefined {
  const path = boundedString(value, MAX_COOKIE_PATH_BYTES) ?? "/";
  if (!path.startsWith("/") || path.includes("\\") || /[\r\n]/u.test(path)) return undefined;
  return path;
}

function cookieUrl(value: unknown, secure: boolean, domain: string, path: string): string | undefined {
  if (value !== undefined) {
    const selected = boundedString(value, 2_048);
    if (selected === undefined) return undefined;
    try {
      const url = new URL(selected);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
      if (url.hostname.toLowerCase() !== domain.replace(/^\./u, "").toLowerCase()) return undefined;
      return url.toString();
    } catch { return undefined; }
  }
  return `${secure ? "https" : "http"}://${domain.replace(/^\./u, "")}${path}`;
}

function normalizedCookie(value: unknown): ElectronCookieDetails | undefined {
  if (!isRecord(value)) return undefined;
  const input = value;
  const allowed = new Set(["name", "value", "domain", "path", "secure", "httpOnly", "expirationDate", "expires", "sameSite", "url", "hostOnly", "session", "storeId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return undefined;
  const name = boundedString(input.name, MAX_COOKIE_NAME_BYTES);
  const cookieValue = boundedString(input.value, MAX_COOKIE_VALUE_BYTES);
  const domain = safeCookieDomain(input.domain);
  const path = safeCookiePath(input.path);
  if (name === undefined || cookieValue === undefined || domain === undefined || path === undefined) return undefined;
  if (input.secure !== undefined && typeof input.secure !== "boolean") return undefined;
  if (input.httpOnly !== undefined && typeof input.httpOnly !== "boolean") return undefined;
  const expiryValue = input.expirationDate ?? input.expires;
  if (expiryValue !== undefined && (typeof expiryValue !== "number" || !Number.isFinite(expiryValue) || expiryValue < 0 || expiryValue > 4_102_444_800)) return undefined;
  let sameSite: ElectronCookieDetails["sameSite"];
  if (input.sameSite !== undefined) {
    if (typeof input.sameSite !== "string") return undefined;
    const normalized = input.sameSite.toLowerCase();
    if (normalized === "strict") sameSite = "strict";
    else if (normalized === "lax") sameSite = "lax";
    else if (normalized === "none" || normalized === "no_restriction") sameSite = "no_restriction";
    else if (normalized === "unspecified") sameSite = "unspecified";
    else return undefined;
  }
  const url = cookieUrl(input.url, input.secure === true, domain, path);
  if (url === undefined) return undefined;
  return {
    url,
    name,
    value: cookieValue,
    domain,
    path,
    ...(input.secure === undefined ? {} : { secure: input.secure }),
    ...(input.httpOnly === undefined ? {} : { httpOnly: input.httpOnly }),
    ...(expiryValue === undefined ? {} : { expirationDate: expiryValue }),
    ...(sameSite === undefined ? {} : { sameSite }),
  };
}

function parseCookieExport(text: string): ElectronCookieDetails[] | undefined {
  if (byteLength(text) > MAX_IMPORT_BYTES) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const parsedObject = isRecord(parsed) ? parsed : undefined;
  const rows = Array.isArray(parsed) ? parsed : parsedObject !== undefined && Array.isArray(parsedObject.cookies) ? parsedObject.cookies : undefined;
  if (!Array.isArray(rows) || rows.length > MAX_COOKIES) return undefined;
  const cookies: ElectronCookieDetails[] = [];
  for (const row of rows) {
    const cookie = normalizedCookie(row);
    if (cookie === undefined) return undefined;
    cookies.push(cookie);
  }
  return cookies;
}

function profileMutation(metadata: BrowserProfileMetadata): BrowserProfileAutomationSuccess<BrowserProfileMutationResult> {
  return success({ profile: metadata });
}

/** Profile lifecycle plus explicit, JSON-only Chromium cookie import. */
export class BrowserProfileAutomation {
  private readonly registry: BrowserProfileRegistry;
  private readonly readSelectedFile: (path: string) => Promise<string>;
  private disposed = false;

  constructor(options: BrowserProfileAutomationOptions) {
    this.registry = options.registry;
    this.readSelectedFile = options.readFile ?? (async (path) => readFile(path, "utf8"));
  }

  list(): BrowserProfileAutomationResult<readonly BrowserProfileMetadata[]> {
    if (this.disposed) return failure("invalid_state", "profile automation is disposed");
    const profiles = this.registry.list().slice(0, 64).map((metadata) => ({ ...metadata }));
    return success(profiles);
  }

  create(options: BrowserProfileCreateOptions = {}): BrowserProfileAutomationResult<BrowserProfileMutationResult> {
    if (this.disposed) return failure("invalid_state", "profile automation is disposed");
    const requestedId = options.profileId === undefined ? undefined : profileId(options.profileId);
    const requestedLabel = options.label === undefined ? undefined : profileLabel(options.label);
    if (options.profileId !== undefined && requestedId === undefined) return failure("invalid_params", "profile id is invalid");
    if (options.label !== undefined && requestedLabel === undefined) return failure("invalid_params", "profile label is invalid");
    try { return profileMutation(this.registry.create({ ...(requestedId === undefined ? {} : { profileId: requestedId }), ...(requestedLabel === undefined ? {} : { label: requestedLabel }) })); } catch { return failure("internal", "browser profile could not be created"); }
  }

  rename(profileIdValue: string, label: string): BrowserProfileAutomationResult<BrowserProfileMutationResult> {
    if (this.disposed) return failure("invalid_state", "profile automation is disposed");
    const id = profileId(profileIdValue);
    const nextLabel = profileLabel(label);
    if (id === undefined || nextLabel === undefined || id === "isolated-session") return failure("invalid_params", "an authenticated profile id and label are required");
    try { return profileMutation(this.registry.rename(id, nextLabel)); } catch { return failure("not_found", "authenticated browser profile was not found"); }
  }

  async clear(selection: BrowserProfileSelectionRequest): Promise<BrowserProfileAutomationResult<BrowserProfileClearResult>> {
    if (this.disposed) return failure("invalid_state", "profile automation is disposed");
    const selected = selectedProfile(selection);
    if ("ok" in selected) return selected;
    if (selected.profileId === "isolated-session") return failure("security", "the isolated browser profile cannot be cleared");
    try {
      await this.registry.clear(selected.profileId);
      return success({ profileId: selected.profileId, cleared: true });
    } catch { return failure("not_found", "authenticated browser profile was not found"); }
  }

  async delete(selection: BrowserProfileSelectionRequest): Promise<BrowserProfileAutomationResult<BrowserProfileDeleteResult>> {
    if (this.disposed) return failure("invalid_state", "profile automation is disposed");
    const selected = selectedProfile(selection);
    if ("ok" in selected) return selected;
    if (selected.profileId === "isolated-session") return failure("security", "the isolated browser profile cannot be deleted");
    try {
      await this.registry.delete(selected.profileId);
      return success({ profileId: selected.profileId, deleted: true });
    } catch { return failure("invalid_state", "authenticated browser profile could not be deleted"); }
  }

  async importCookies(request: BrowserCookieImportRequest): Promise<BrowserProfileAutomationResult<BrowserCookieImportResult>> {
    if (this.disposed) return failure("invalid_state", "profile automation is disposed");
    const selected = selectedProfile(request);
    if ("ok" in selected) return selected;
    const filePath = boundedString(request.filePath, MAX_FILE_PATH_BYTES);
    if (filePath === undefined || extname(filePath).toLowerCase() !== ".json") return failure("not_supported", "cookie import requires an explicitly selected JSON export file");
    if (selected.profileId === "isolated-session") return failure("security", "cookie import requires an explicitly selected authenticated profile");
    let cookies: ElectronCookieDetails[] | undefined;
    try { cookies = parseCookieExport(await this.readSelectedFile(filePath)); } catch { return failure("not_supported", "the selected cookie export could not be read"); }
    if (cookies === undefined) return failure("not_supported", "the selected file is not a safely parseable Chromium cookie export");
    let session: Session;
    try { session = this.registry.getSession({ kind: "authenticated-profile", profileId: selected.profileId, explicitOptIn: true }); } catch { return failure("security", "authenticated browser profile selection was not exact"); }
    const cookieStore = session.cookies;
    if (!isCookieStore(cookieStore)) return failure("not_supported", "Electron cookie storage is unavailable");
    try {
      for (const cookie of cookies) await cookieStore.set(cookie);
    } catch { return failure("internal", "one or more imported cookies could not be applied"); }
    return success({ profileId: selected.profileId, imported: cookies.length, selected: false });
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function createBrowserProfileAutomation(options: BrowserProfileAutomationOptions): BrowserProfileAutomation {
  return new BrowserProfileAutomation(options);
}

export { browserProfileToProtocol };
export const BrowserProfileController = BrowserProfileAutomation;
