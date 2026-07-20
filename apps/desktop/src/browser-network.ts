import type { Session, WebContents } from "electron";

const MAX_TEXT_BYTES = 4_096;
const MAX_HEADER_BYTES = 2_048;
const MAX_HEADERS = 64;
const MAX_ROUTES = 64;
const MAX_ROUTE_PATTERN_BYTES = 512;
const MAX_REQUESTS = 256;
const MAX_REQUEST_URL_BYTES = 8_192;
const MAX_ROUTE_ID_BYTES = 96;
const MAX_DEVICE_KEYS = 32;
const SECRET_KEY = /(?:authorization|cookie|set-cookie|proxy-authorization|token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|session)/iu;
const SENSITIVE_QUERY_KEY = /(?:authorization|auth|cookie|token|secret|password|passwd|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session|code)/iu;
const NETWORK_FILTER = ["http://*/*", "https://*/*"];

type NetworkErrorCode = "invalid_params" | "invalid_state" | "not_supported" | "internal";

export interface BrowserNetworkFailure {
  readonly ok: false;
  readonly code: NetworkErrorCode;
  readonly message: string;
  readonly reason: string;
}

export interface BrowserNetworkSuccess<T = undefined> {
  readonly ok: true;
  readonly value: T;
}

export type BrowserNetworkResult<T = undefined> = BrowserNetworkSuccess<T> | BrowserNetworkFailure;

export interface BrowserOfflineOptions {
  readonly offline: boolean;
  readonly latencyMs?: number;
  readonly downloadThroughputBytesPerSecond?: number;
  readonly uploadThroughputBytesPerSecond?: number;
}

export interface BrowserHeaderSettings {
  readonly headers: Readonly<Record<string, string>>;
}

export interface BrowserDeviceSettings {
  readonly [key: string]: unknown;
}

export interface BrowserNetworkRoute {
  readonly routeId?: string;
  readonly urlPattern: string;
  readonly action: "abort" | "redirect";
  readonly redirectUrl?: string;
}

export interface BrowserNetworkRouteInfo {
  readonly routeId: string;
  readonly action: "abort" | "redirect";
}

export interface BrowserNetworkRequest {
  readonly requestId: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly statusCode?: number;
  readonly error?: string;
}

export interface BrowserNetworkRequestOptions {
  readonly limit?: number;
}

export interface BrowserNetworkControllerOptions {
  readonly session: Session;
  readonly webContents?: WebContents;
  readonly now?: () => number;
}

interface WebRequestDetails {
  readonly id: number;
  readonly url: string;
  readonly webContentsId?: number;
  readonly method?: string;
  readonly resourceType?: string;
  readonly statusCode?: number;
  readonly error?: string;
}

type BeforeRequestListener = (details: WebRequestDetails, callback: (response: { readonly cancel?: boolean; readonly redirectURL?: string }) => void) => void;
type HeaderDetails = {
  readonly webContentsId?: number;
  readonly requestHeaders: Record<string, string>;
};
type HeaderListener = (details: HeaderDetails, callback: (response: { readonly requestHeaders: Record<string, string> }) => void) => void;
type RequestDetailsListener = (details: WebRequestDetails) => void;

interface WebRequestLike {
  onBeforeRequest(filter: { readonly urls: readonly string[] }, listener: BeforeRequestListener | null): void;
  onBeforeSendHeaders?(filter: { readonly urls: readonly string[] }, listener: HeaderListener | null): void;
  onCompleted?(filter: { readonly urls: readonly string[] }, listener: RequestDetailsListener | null): void;
  onErrorOccurred?(filter: { readonly urls: readonly string[] }, listener: RequestDetailsListener | null): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function boundedString(value: unknown, maxBytes = MAX_TEXT_BYTES): string | undefined {
  if (typeof value !== "string") return undefined;
  let result = replaceControlCharacters(value.normalize("NFKC"), " ").trim();
  if (result.length === 0) return undefined;
  while (byteLength(result) > maxBytes) result = result.slice(0, Math.max(1, result.length - 1));
  return result.length > 0 && byteLength(result) <= maxBytes ? result : undefined;
}

type SessionNetworkLike = Session & {
  readonly webRequest?: WebRequestLike;
};

type WebContentsNetworkLike = WebContents & {
  readonly id?: number;
  enableDeviceEmulation?: (parameters: Record<string, unknown>) => void;
  disableDeviceEmulation?: () => void;
  setUserAgent?: (userAgent: string) => void;
  getUserAgent?: () => string;
  setAudioMuted?: (muted: boolean) => void;
};

interface RouteEntry {
  readonly info: BrowserNetworkRouteInfo;
  readonly pattern: string;
  readonly expression: RegExp;
  readonly redirectUrl?: string;
}

interface SessionNetworkPolicy {
  readonly beforeRequest: BeforeRequestListener;
  readonly beforeSendHeaders: HeaderListener;
  readonly completed: RequestDetailsListener;
  readonly failed: RequestDetailsListener;
}

interface SessionNetworkState {
  readonly policies: Map<number, SessionNetworkPolicy>;
  readonly webRequest: WebRequestLike;
}

const sessionNetworkStates = new WeakMap<SessionNetworkLike, SessionNetworkState>();

function policyFor(
  policies: ReadonlyMap<number, SessionNetworkPolicy>,
  webContentsId: number | undefined,
): SessionNetworkPolicy | undefined {
  return Number.isSafeInteger(webContentsId) ? policies.get(webContentsId as number) : undefined;
}

/** Electron keeps only the last WebRequest listener, so one listener must multiplex a shared Session. */
function registerSessionNetworkPolicy(
  session: SessionNetworkLike,
  webContentsId: number,
  policy: SessionNetworkPolicy,
): () => void {
  const webRequest = session.webRequest;
  if (webRequest === undefined) return () => {};
  let state = sessionNetworkStates.get(session);
  if (state === undefined) {
    const policies = new Map<number, SessionNetworkPolicy>();
    state = { policies, webRequest };
    sessionNetworkStates.set(session, state);
    webRequest.onBeforeRequest({ urls: NETWORK_FILTER }, (details, callback) => {
      const selected = policyFor(policies, details.webContentsId);
      if (selected === undefined) callback({});
      else selected.beforeRequest(details, callback);
    });
    webRequest.onBeforeSendHeaders?.({ urls: NETWORK_FILTER }, (details, callback) => {
      const selected = policyFor(policies, details.webContentsId);
      if (selected === undefined) callback({ requestHeaders: { ...details.requestHeaders } });
      else selected.beforeSendHeaders(details, callback);
    });
    webRequest.onCompleted?.({ urls: NETWORK_FILTER }, (details) => {
      policyFor(policies, details.webContentsId)?.completed(details);
    });
    webRequest.onErrorOccurred?.({ urls: NETWORK_FILTER }, (details) => {
      policyFor(policies, details.webContentsId)?.failed(details);
    });
  }
  const registeredState = state;
  registeredState.policies.set(webContentsId, policy);

  return (): void => {
    if (registeredState.policies.get(webContentsId) !== policy) return;
    registeredState.policies.delete(webContentsId);
    if (registeredState.policies.size > 0) return;
    sessionNetworkStates.delete(session);
    registeredState.webRequest.onBeforeRequest({ urls: NETWORK_FILTER }, null);
    registeredState.webRequest.onBeforeSendHeaders?.({ urls: NETWORK_FILTER }, null);
    registeredState.webRequest.onCompleted?.({ urls: NETWORK_FILTER }, null);
    registeredState.webRequest.onErrorOccurred?.({ urls: NETWORK_FILTER }, null);
  };
}


function failure(code: NetworkErrorCode, reason: string): BrowserNetworkFailure {
  const safeReason = boundedString(reason, MAX_TEXT_BYTES) ?? "network operation failed";
  return { ok: false, code, reason: safeReason, message: safeReason };
}

function success<T>(value: T): BrowserNetworkSuccess<T> { return { ok: true, value }; }
function unsupported(reason: string): BrowserNetworkFailure { return failure("not_supported", reason); }

function safeUrl(value: unknown, maxBytes = MAX_REQUEST_URL_BYTES): string | undefined {
  const candidate = boundedString(value, maxBytes);
  if (candidate === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  parsed.hash = "";
  for (const key of Array.from(parsed.searchParams.keys())) if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.delete(key);
  const result = parsed.toString();
  return byteLength(result) <= maxBytes ? result : undefined;
}

function safeRouteId(value: unknown): string | undefined {
  const result = boundedString(value, MAX_ROUTE_ID_BYTES);
  return result !== undefined && /^[a-z][a-z0-9._-]{0,95}$/u.test(result) ? result : undefined;
}

function routeExpression(value: unknown): { readonly pattern: string; readonly expression: RegExp } | undefined {
  const pattern = boundedString(value, MAX_ROUTE_PATTERN_BYTES);
  if (pattern === undefined || !/^https?:\/\//iu.test(pattern) || /[\r\n<>]/u.test(pattern)) return undefined;
  const authorityAndPath = pattern.slice(pattern.indexOf("://") + 3);
  const slash = authorityAndPath.indexOf("/");
  const authority = slash < 0 ? authorityAndPath : authorityAndPath.slice(0, slash);
  if (authority.length === 0 || authority.includes("@") || authority.includes("\\") || /[^a-z0-9.*:[\]-]/iu.test(authority)) return undefined;
  if (authority.includes("*") && authority !== "*") return undefined;
  let parsedPattern = pattern;
  const queryStart = parsedPattern.indexOf("?");
  if (queryStart >= 0) {
    const query = parsedPattern.slice(queryStart + 1);
    for (const item of query.split("&")) {
      const key = item.split("=", 1)[0] ?? "";
      if (SENSITIVE_QUERY_KEY.test(key)) return undefined;
    }
  }
  const escaped = parsedPattern.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&").replace(/\*/gu, ".*");
  try { return { pattern, expression: new RegExp(`^${escaped}$`, "iu") }; } catch { return undefined; }
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) return undefined;
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = boundedString(rawKey, 256)?.toLowerCase();
    const headerValue = boundedString(rawValue, MAX_HEADER_BYTES);
    if (key === undefined || headerValue === undefined || !/^[a-z][a-z0-9-]{0,127}$/u.test(key) || SECRET_KEY.test(key) || /[\r\n]/u.test(headerValue)) return undefined;
    result[key] = headerValue;
  }
  return result;
}

function normalizeDevice(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const input = value;
  const allowed = new Set(["screenPosition", "screenSize", "viewPosition", "viewSize", "deviceScaleFactor", "scale"]);
  const entries = Object.entries(input);
  if (entries.length > MAX_DEVICE_KEYS || entries.some(([key]) => !allowed.has(key))) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (key === "screenPosition") {
      if (item !== "desktop" && item !== "mobile") return undefined;
      result[key] = item;
      continue;
    }
    if (key === "deviceScaleFactor" || key === "scale") {
      if (typeof item !== "number" || !Number.isFinite(item) || item <= 0 || item > 100) return undefined;
      result[key] = item;
      continue;
    }
    if (!isRecord(item)) return undefined;
    const dimension = item;
    const dimensionKeys = Object.keys(dimension);
    if (dimensionKeys.some((dimensionKey) => dimensionKey !== "width" && dimensionKey !== "height" && dimensionKey !== "x" && dimensionKey !== "y") || dimensionKeys.length !== 2) return undefined;
    const normalized: Record<string, number> = {};
    for (const dimensionKey of dimensionKeys) {
      const numberValue = dimension[dimensionKey];
      if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue < 0 || numberValue > 100_000) return undefined;
      normalized[dimensionKey] = numberValue;
    }
    result[key] = normalized;
  }
  return result;
}

function safeResourceType(value: unknown): string | undefined {
  const result = boundedString(value, 64);
  return result !== undefined && /^[a-z][a-z0-9_-]{0,63}$/iu.test(result) ? result : undefined;
}

/**
 * Controls one WebContents while multiplexing Electron's Session-wide
 * WebRequest hooks. It never records request bodies or headers.
 */
export class BrowserNetworkController {
  private readonly targetSession: SessionNetworkLike;
  private readonly targetWebContents: WebContentsNetworkLike | undefined;
  private readonly now: () => number;
  private readonly routes = new Map<string, RouteEntry>();
  private readonly requests: BrowserNetworkRequest[] = [];
  private readonly beforeRequestListener: (details: WebRequestDetails, callback: (response: { readonly cancel?: boolean; readonly redirectURL?: string }) => void) => void;
  private readonly beforeSendHeadersListener: (details: HeaderDetails, callback: (response: { readonly requestHeaders: Record<string, string> }) => void) => void;
  private readonly completedListener: (details: WebRequestDetails) => void;
  private readonly errorListener: (details: WebRequestDetails) => void;
  private readonly disposeNetworkPolicy: () => void;
  private configuredHeaders: Readonly<Record<string, string>> = Object.freeze({});
  private originalUserAgent: string | undefined;
  private userAgentChanged = false;
  private deviceEmulationEnabled = false;
  private disposed = false;
  private nextRouteNumber = 1;

  constructor(options: BrowserNetworkControllerOptions) {
    this.targetSession = options.session as SessionNetworkLike;
    this.targetWebContents = options.webContents as WebContentsNetworkLike | undefined;
    this.now = options.now ?? Date.now;
    this.originalUserAgent = this.targetWebContents?.getUserAgent?.();
    this.beforeRequestListener = (details, callback) => {
      const requestId = Number.isSafeInteger(details.id) ? details.id : 0;
      const url = safeUrl(details.url);
      if (url !== undefined) {
        const resourceType = safeResourceType(details.resourceType);
        this.requests.push({
          requestId,
          method: boundedString(details.method, 32) ?? "GET",
          url,
          ...(resourceType === undefined ? {} : { resourceType }),
          startedAt: this.now(),
        });
        while (this.requests.length > MAX_REQUESTS) this.requests.shift();
      }
      const route = url === undefined ? undefined : [...this.routes.values()].find((candidate) => candidate.expression.test(details.url));
      if (route?.info.action === "abort") callback({ cancel: true });
      else if (route?.info.action === "redirect" && route.redirectUrl !== undefined) callback({ redirectURL: route.redirectUrl });
      else callback({});
    };
    this.beforeSendHeadersListener = (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      for (const [key, value] of Object.entries(this.configuredHeaders)) requestHeaders[key] = value;
      callback({ requestHeaders });
    };
    this.completedListener = (details) => this.finishRequest(details, false);
    this.errorListener = (details) => this.finishRequest(details, true);
    const webContentsId = this.targetWebContents?.id;
    this.disposeNetworkPolicy = Number.isSafeInteger(webContentsId)
      ? registerSessionNetworkPolicy(this.targetSession, webContentsId as number, {
          beforeRequest: this.beforeRequestListener,
          beforeSendHeaders: this.beforeSendHeadersListener,
          completed: this.completedListener,
          failed: this.errorListener,
        })
      : () => {};
  }

  private finishRequest(details: WebRequestDetails, failed: boolean): void {
    const request = this.requests.find((item) => item.requestId === details.id);
    if (request === undefined) return;
    const index = this.requests.indexOf(request);
    const rawStatusCode = details.statusCode;
    const statusCode = typeof rawStatusCode === "number" && Number.isInteger(rawStatusCode) && rawStatusCode >= 100 && rawStatusCode <= 599 ? rawStatusCode : undefined;
    const error = failed ? boundedString(details.error, 256) : undefined;
    this.requests[index] = {
      ...request,
      finishedAt: this.now(),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(error === undefined ? {} : { error }),
    };
  }

  setOffline(options: BrowserOfflineOptions): BrowserNetworkResult<{ readonly offline: boolean }> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    if (typeof options !== "object" || options === null || typeof options.offline !== "boolean") return failure("invalid_params", "offline must be a boolean");
    const latency = options.latencyMs ?? 0;
    const download = options.downloadThroughputBytesPerSecond ?? -1;
    const upload = options.uploadThroughputBytesPerSecond ?? -1;
    if (![latency, download, upload].every((value) => typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= Number.MAX_SAFE_INTEGER)) return failure("invalid_params", "network emulation values are invalid");
    return unsupported("Electron network emulation is session-wide and cannot be safely scoped to one browser surface");
  }

  setUserAgent(userAgent: string): BrowserNetworkResult<{ readonly applied: true }> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    const value = boundedString(userAgent, MAX_TEXT_BYTES);
    if (value === undefined || /[\r\n]/u.test(value)) return failure("invalid_params", "user agent is invalid");
    if (typeof this.targetWebContents?.setUserAgent !== "function") return unsupported("Electron does not expose per-surface user-agent configuration");
    try {
      this.targetWebContents.setUserAgent(value);
      this.userAgentChanged = true;
      return success({ applied: true });
    } catch { return failure("internal", "surface user-agent could not be applied"); }
  }

  setHeaders(settings: BrowserHeaderSettings): BrowserNetworkResult<{ readonly count: number }> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    if (this.targetSession.webRequest === undefined || !Number.isSafeInteger(this.targetWebContents?.id)) return unsupported("Electron webRequest header interception is unavailable");
    const headers = normalizeHeaders(settings?.headers);
    if (headers === undefined) return failure("invalid_params", "headers are invalid or contain credentials");
    this.configuredHeaders = Object.freeze({ ...headers });
    return success({ count: Object.keys(headers).length });
  }

  setDevice(settings: BrowserDeviceSettings): BrowserNetworkResult<{ readonly applied: true }> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    const parameters = normalizeDevice(settings);
    if (parameters === undefined) return failure("invalid_params", "device settings are invalid");
    if (this.targetWebContents === undefined || typeof this.targetWebContents.enableDeviceEmulation !== "function") return unsupported("Electron does not expose truthful device emulation for this surface");
    try {
      this.targetWebContents.enableDeviceEmulation(parameters);
      this.deviceEmulationEnabled = true;
      return success({ applied: true });
    } catch { return failure("internal", "device emulation could not be applied"); }
  }

  setGeolocation(_settings: unknown): BrowserNetworkResult<never> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    return unsupported("Electron cannot truthfully override navigator.geolocation per session");
  }

  setCredentials(_settings: unknown): BrowserNetworkResult<never> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    return unsupported("Electron has no safe per-session credential emulation API");
  }

  setMedia(_settings: unknown): BrowserNetworkResult<never> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    return unsupported("Electron cannot truthfully emulate media devices per session");
  }

  route(route: BrowserNetworkRoute): BrowserNetworkResult<BrowserNetworkRouteInfo> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    if (this.targetSession.webRequest === undefined || !Number.isSafeInteger(this.targetWebContents?.id)) return unsupported("Electron webRequest routing is unavailable");
    if (this.routes.size >= MAX_ROUTES) return failure("invalid_params", "network route limit reached");
    const expression = routeExpression(route?.urlPattern);
    if (expression === undefined) return failure("invalid_params", "network route pattern is invalid");
    if (route.action !== "abort" && route.action !== "redirect") return failure("invalid_params", "network route action is invalid");
    const routeId = safeRouteId(route.routeId) ?? `route-${this.nextRouteNumber++}`;
    if (this.routes.has(routeId)) return failure("invalid_params", "network route id is already in use");
    let redirectUrl: string | undefined;
    if (route.action === "redirect") {
      redirectUrl = safeUrl(route.redirectUrl);
      if (redirectUrl === undefined) return failure("invalid_params", "redirect URL is invalid");
    }
    const info: BrowserNetworkRouteInfo = { routeId, action: route.action };
    this.routes.set(routeId, { info, pattern: expression.pattern, expression: expression.expression, ...(redirectUrl === undefined ? {} : { redirectUrl }) });
    return success(info);
  }

  unroute(routeId: string): BrowserNetworkResult<{ readonly removed: boolean }> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    const id = safeRouteId(routeId);
    if (id === undefined) return failure("invalid_params", "network route id is invalid");
    return success({ removed: this.routes.delete(id) });
  }

  listRequests(options: BrowserNetworkRequestOptions = {}): BrowserNetworkResult<readonly BrowserNetworkRequest[]> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    const limit = options.limit ?? MAX_REQUESTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REQUESTS) return failure("invalid_params", "request limit is invalid");
    return success(this.requests.slice(-limit).map((request) => ({ ...request })));
  }

  listRoutes(): BrowserNetworkResult<readonly BrowserNetworkRouteInfo[]> {
    if (this.disposed) return failure("invalid_state", "network controller is disposed");
    return success([...this.routes.values()].map((route) => ({ ...route.info })));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.routes.clear();
    this.configuredHeaders = Object.freeze({});
    this.disposeNetworkPolicy();
    if (this.deviceEmulationEnabled) {
      try { this.targetWebContents?.disableDeviceEmulation?.(); } catch { /* best effort */ }
    }
    if (this.userAgentChanged && this.originalUserAgent !== undefined && typeof this.targetWebContents?.setUserAgent === "function") {
      try { this.targetWebContents.setUserAgent(this.originalUserAgent); } catch { /* best effort */ }
    }
    this.requests.length = 0;
  }
}

export function createBrowserNetworkController(options: BrowserNetworkControllerOptions): BrowserNetworkController {
  return new BrowserNetworkController(options);
}

export const BrowserNetworkAutomation = BrowserNetworkController;
