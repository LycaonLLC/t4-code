import { isSecretLikeKey, utf8ByteLength } from "@oh-my-pi/app-wire";

/** Browser IPC wire version. The version is intentionally independent of Electron. */
export const BROWSER_IPC_VERSION = 1 as const;

export const BROWSER_METHODS = [
  "surface.create",
  "surface.list",
  "surface.get",
  "surface.close",
  "surface.navigate",
  "surface.reload",
  "surface.goBack",
  "surface.goForward",
  "surface.stop",
  "surface.snapshot",
  "surface.screenshot",
  "surface.wait",
  "surface.text",
  "surface.html",
  "surface.title",
  "surface.evaluate",
  "surface.find",
  "surface.click",
  "surface.fill",
  "surface.type",
  "surface.press",
  "surface.select",
  "surface.scroll",
  "surface.hover",
  "surface.console",
  "surface.cookies",
  "surface.storage",
  "surface.downloads",
  "surface.setBounds",
  "surface.setMuted",
  "surface.setOmnibarVisible",
  "surface.focusAddressBar",
  "surface.focusWebView",
  "surface.restore",
  "browser.open_split",
  "browser.navigate",
  "browser.back",
  "browser.forward",
  "browser.reload",
  "browser.design_mode.set",
  "browser.design_mode.status",
  "browser.snapshot",
  "browser.eval",
  "browser.wait",
  "browser.screenshot",
  "browser.click",
  "browser.dblclick",
  "browser.hover",
  "browser.focus",
  "browser.type",
  "browser.fill",
  "browser.press",
  "browser.keydown",
  "browser.keyup",
  "browser.check",
  "browser.uncheck",
  "browser.select",
  "browser.scroll",
  "browser.scroll_into_view",
  "browser.get.text",
  "browser.get.html",
  "browser.get.value",
  "browser.get.attr",
  "browser.get.count",
  "browser.get.box",
  "browser.get.styles",
  "browser.get.title",
  "browser.is.visible",
  "browser.is.enabled",
  "browser.is.checked",
  "browser.find.role",
  "browser.find.text",
  "browser.find.label",
  "browser.find.placeholder",
  "browser.find.testid",
  "browser.find.first",
  "browser.find.last",
  "browser.find.nth",
  "browser.highlight",
  "browser.frame.select",
  "browser.frame.main",
  "browser.dialog.accept",
  "browser.dialog.dismiss",
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
  "browser.console.list",
  "browser.console.clear",
  "browser.console.show",
  "browser.errors.list",
  "browser.state.save",
  "browser.state.load",
  "browser.addinitscript",
  "browser.addscript",
  "browser.addstyle",
  "browser.download.wait",
  "browser.profiles.list",
  "browser.profiles.create",
  "browser.profiles.rename",
  "browser.profiles.clear",
  "browser.profiles.delete",
  "browser.import.cookies",
  "browser.import.dialog",
  "browser.react_grab.toggle",
  "browser.devtools.toggle",
  "browser.focus_mode.set",
  "browser.zoom.set",
  "browser.history.clear",
  "browser.url.get",
  "browser.focus_webview",
  "browser.is_webview_focused",
  "browser.tab.new",
  "browser.tab.list",
  "browser.tab.switch",
  "browser.tab.close",
  "browser.viewport.set",
  "browser.geolocation.set",
  "browser.offline.set",
  "browser.trace.start",
  "browser.trace.stop",
  "browser.network.route",
  "browser.network.unroute",
  "browser.network.requests",
  "browser.screencast.start",
  "browser.screencast.stop",
  "browser.input_mouse",
  "browser.input_keyboard",
  "browser.input_touch",
] as const;
export type BrowserMethod = (typeof BROWSER_METHODS)[number];
export type BrowserMethodName = BrowserMethod;

export const BROWSER_CHANNELS = ["browser:call", "browser:event"] as const;
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];
export type BrowserIpcChannel = BrowserChannel;
export interface BrowserChannelMap {
  readonly "browser:call": BrowserCall;
  readonly "browser:event": BrowserEvent;
}
export type BrowserChannelPayload<C extends BrowserChannel> = BrowserChannelMap[C];
export const BROWSER_EVENT_TYPES = ["state", "download", "console", "error"] as const;
export type BrowserEventType = (typeof BROWSER_EVENT_TYPES)[number];

export type BrowserErrorCode =
  | "invalid_params"
  | "not_found"
  | "invalid_state"
  | "not_supported"
  | "timeout"
  | "security"
  | "internal";

export interface BrowserError {
  readonly code: BrowserErrorCode;
  readonly message: string;
  readonly method?: BrowserMethod;
  readonly surfaceId?: SurfaceId;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, BrowserJsonValue>>;
}
export type BrowserIpcError = BrowserError;

export type SurfaceId = string & { readonly __surfaceId: unique symbol };
/** Bounded, durable workspace-session identity used to scope native browser surfaces. */
export type OwnerSessionId = string & { readonly __ownerSessionId: unique symbol };
export type SurfaceHandle = `surface:${number}`;
export type ElementRef = `@e${number}`;
export type BrowserElementRef = ElementRef;

export type BrowserJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BrowserJsonValue[]
  | { readonly [key: string]: BrowserJsonValue };

export type BrowserProfile =
  | {
      readonly kind: "isolated-session";
      readonly profileId: "isolated-session";
    }
  | {
      readonly kind: "authenticated-profile";
      readonly profileId: string;
      readonly explicitOptIn: true;
    };
export type BrowserProfileKind = BrowserProfile["kind"];
export type BrowserProfileSelection = BrowserProfile;

export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BrowserSurfaceLifecycle =
  | "creating"
  | "loading"
  | "ready"
  | "closed"
  | "crashed"
  | "failed";
export type BrowserReadyState = "loading" | "interactive" | "complete";

export interface BrowserSurfaceState {
  readonly surfaceId: SurfaceId;
  readonly handle: SurfaceHandle;
  readonly profile: BrowserProfile;
  readonly url: string;
  readonly title: string;
  readonly faviconUrl?: string;
  readonly lifecycle: BrowserSurfaceLifecycle;
  readonly readyState: BrowserReadyState;
  readonly loading: boolean;
  readonly progress: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly bounds: BrowserBounds;
  readonly visible: boolean;
  readonly muted: boolean;
  readonly focused: "address" | "webview" | "none";
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type BrowserSurface = BrowserSurfaceState;

export interface BrowserSnapshotElement {
  readonly ref: ElementRef;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly text?: string;
  readonly bounds?: BrowserBounds;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly expanded?: boolean;
}

export interface BrowserSnapshot {
  readonly surfaceId: SurfaceId;
  readonly handle: SurfaceHandle;
  readonly url: string;
  readonly title: string;
  readonly readyState: BrowserReadyState;
  readonly viewport: BrowserBounds;
  readonly elements: readonly BrowserSnapshotElement[];
  readonly capturedAt: number;
  readonly truncated?: boolean;
}
export type BrowserSurfaceSnapshot = BrowserSnapshot;

export type BrowserDownloadState = "started" | "progress" | "completed" | "cancelled" | "failed";
export interface BrowserDownload {
  readonly downloadId: string;
  readonly surfaceId: SurfaceId;
  readonly state: BrowserDownloadState;
  readonly url: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly totalBytes?: number;
  readonly receivedBytes?: number;
  readonly savePath?: string;
  readonly failure?: string;
}

export type BrowserConsoleLevel = "debug" | "info" | "log" | "warn" | "error";
export interface BrowserConsoleMessage {
  readonly level: BrowserConsoleLevel;
  readonly message: string;
  readonly args: readonly BrowserJsonValue[];
  readonly source?: string;
  readonly url?: string;
  readonly line?: number;
  readonly column?: number;
  readonly timestamp: number;
  readonly surfaceId: SurfaceId;
}

export type BrowserRuntimeErrorKind = "page" | "navigation" | "renderer" | "certificate" | "security" | "download";
export interface BrowserRuntimeError {
  readonly surfaceId: SurfaceId;
  readonly kind: BrowserRuntimeErrorKind;
  readonly code: string;
  readonly message: string;
  readonly url?: string;
  readonly fatal: boolean;
  readonly timestamp: number;
}

export type BrowserEvent =
  | { readonly type: "state"; readonly surface: BrowserSurfaceState; readonly ownerSessionId?: OwnerSessionId }
  | { readonly type: "download"; readonly download: BrowserDownload; readonly ownerSessionId?: OwnerSessionId }
  | { readonly type: "console"; readonly console: BrowserConsoleMessage; readonly ownerSessionId?: OwnerSessionId }
  | { readonly type: "error"; readonly error: BrowserRuntimeError; readonly ownerSessionId?: OwnerSessionId };
export type BrowserIpcEvent = BrowserEvent;
export type BrowserStateEvent = Extract<BrowserEvent, { readonly type: "state" }>;
export type BrowserDownloadEvent = Extract<BrowserEvent, { readonly type: "download" }>;
export type BrowserConsoleEvent = Extract<BrowserEvent, { readonly type: "console" }>;
export type BrowserErrorEvent = Extract<BrowserEvent, { readonly type: "error" }>;

export interface BrowserActionOptions {
  readonly snapshotAfter?: boolean;
}
export interface BrowserActionResult {
  readonly surface: BrowserSurfaceState;
  readonly postActionSnapshot?: BrowserSnapshot;
}

export interface CreateSurfaceRequest {
  readonly profile: BrowserProfile;
  readonly url?: string;
  readonly bounds?: BrowserBounds;
  readonly visible?: boolean;
}
export interface CreateSurfaceResult {
  readonly surface: BrowserSurfaceState;
  readonly snapshot?: BrowserSnapshot;
}
export interface SurfaceIdRequest {
  readonly surfaceId: SurfaceId;
}
export interface SurfaceListRequest {}
export interface SurfaceListResult {
  readonly surfaces: readonly BrowserSurfaceState[];
}
export interface SurfaceResult {
  readonly surface: BrowserSurfaceState;
}
export interface NavigateRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly url: string;
}
export interface UrlActionRequest extends SurfaceIdRequest, BrowserActionOptions {}
export interface SnapshotRequest extends SurfaceIdRequest {
  readonly includeText?: boolean;
}
export interface SnapshotResult {
  readonly snapshot: BrowserSnapshot;
}
export interface ScreenshotRequest extends SurfaceIdRequest {
  readonly bounds?: BrowserBounds;
  readonly format?: "png" | "jpeg";
  readonly quality?: number;
}
export interface ScreenshotResult {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly data: string;
}
export interface WaitRequest extends SurfaceIdRequest {
  readonly selector?: string;
  readonly state?: "visible" | "hidden" | "attached" | "detached";
  readonly timeoutMs?: number;
}
export interface WaitResult extends BrowserActionResult {
  readonly matched: boolean;
}
export interface TextRequest extends SurfaceIdRequest {
  readonly ref?: ElementRef;
  readonly selector?: string;
}
export interface TextResult {
  readonly text: string;
}
export interface HtmlRequest extends SurfaceIdRequest {
  readonly ref?: ElementRef;
  readonly selector?: string;
}
export interface HtmlResult {
  readonly html: string;
}
export interface TitleRequest extends SurfaceIdRequest {}
export interface TitleResult {
  readonly title: string;
  readonly url: string;
}
export interface EvaluateRequest extends SurfaceIdRequest {
  readonly expression: string;
  readonly args?: readonly BrowserJsonValue[];
}
export interface EvaluateResult {
  readonly value: BrowserJsonValue;
}
export interface FindRequest extends SurfaceIdRequest {
  readonly query: string;
  readonly limit?: number;
}
export interface FindResult {
  readonly elements: readonly BrowserSnapshotElement[];
}
export interface ClickRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly ref?: ElementRef;
  readonly selector?: string;
  readonly button?: "left" | "middle" | "right";
  readonly clickCount?: number;
}
export interface FillRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly ref?: ElementRef;
  readonly selector?: string;
  readonly value: string;
}
export interface TypeRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly text: string;
  readonly ref?: ElementRef;
  readonly selector?: string;
  readonly intervalMs?: number;
}
export interface PressRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly key: string;
  readonly modifiers?: readonly ("Alt" | "Control" | "Meta" | "Shift")[];
}
export interface SelectRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly ref?: ElementRef;
  readonly selector?: string;
  readonly values: readonly string[];
}
export interface ScrollRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly ref?: ElementRef;
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
}
export interface HoverRequest extends SurfaceIdRequest, BrowserActionOptions {
  readonly ref?: ElementRef;
  readonly selector?: string;
}
export interface ConsoleRequest extends SurfaceIdRequest {
  readonly levels?: readonly BrowserConsoleLevel[];
}
export interface ConsoleResult {
  readonly messages: readonly BrowserConsoleMessage[];
}
export interface CookiesRequest extends SurfaceIdRequest {
  readonly operation: "get" | "clear";
  readonly url?: string;
}
export interface CookiesResult {
  readonly count: number;
}
export interface StorageRequest extends SurfaceIdRequest {
  readonly operation: "get" | "clear";
  readonly storageArea?: "local" | "session";
  readonly key?: string;
}
export interface StorageResult {
  readonly entries: Readonly<Record<string, string>>;
}
export interface DownloadsRequest extends SurfaceIdRequest {}
export interface DownloadsResult {
  readonly downloads: readonly BrowserDownload[];
}
export interface SetBoundsRequest extends SurfaceIdRequest {
  readonly bounds: BrowserBounds;
  readonly visible?: boolean;
}
export interface SetMutedRequest extends SurfaceIdRequest {
  readonly muted: boolean;
}
export interface SetOmnibarVisibleRequest extends SurfaceIdRequest {
  readonly visible: boolean;
}
export interface RestoreRequest extends SurfaceIdRequest {
  readonly url?: string;
}
export type BrowserRequestBase = unknown;
export type BrowserResultBase = unknown;

export interface BrowserRequestMap {
  readonly "surface.create": CreateSurfaceRequest;
  readonly "surface.list": SurfaceListRequest;
  readonly "surface.get": SurfaceIdRequest;
  readonly "surface.close": SurfaceIdRequest;
  readonly "surface.navigate": NavigateRequest;
  readonly "surface.reload": UrlActionRequest;
  readonly "surface.goBack": UrlActionRequest;
  readonly "surface.goForward": UrlActionRequest;
  readonly "surface.stop": UrlActionRequest;
  readonly "surface.snapshot": SnapshotRequest;
  readonly "surface.screenshot": ScreenshotRequest;
  readonly "surface.wait": WaitRequest;
  readonly "surface.text": TextRequest;
  readonly "surface.html": HtmlRequest;
  readonly "surface.title": TitleRequest;
  readonly "surface.evaluate": EvaluateRequest;
  readonly "surface.find": FindRequest;
  readonly "surface.click": ClickRequest;
  readonly "surface.fill": FillRequest;
  readonly "surface.type": TypeRequest;
  readonly "surface.press": PressRequest;
  readonly "surface.select": SelectRequest;
  readonly "surface.scroll": ScrollRequest;
  readonly "surface.hover": HoverRequest;
  readonly "surface.console": ConsoleRequest;
  readonly "surface.cookies": CookiesRequest;
  readonly [method: string]: BrowserRequestBase;
  readonly "surface.storage": StorageRequest;
  readonly "surface.downloads": DownloadsRequest;
  readonly "surface.setBounds": SetBoundsRequest;
  readonly "surface.setMuted": SetMutedRequest;
  readonly "surface.setOmnibarVisible": SetOmnibarVisibleRequest;
  readonly "surface.focusAddressBar": UrlActionRequest;
  readonly "surface.focusWebView": UrlActionRequest;
  readonly "surface.restore": RestoreRequest;
}
export type BrowserRequest<M extends BrowserMethod = BrowserMethod> = { readonly method: M; readonly request: BrowserRequestMap[M] };
export type BrowserIpcRequest<M extends BrowserMethod = BrowserMethod> = BrowserRequest<M>;

export interface BrowserResultMap {
  readonly "surface.create": CreateSurfaceResult;
  readonly "surface.list": SurfaceListResult;
  readonly "surface.get": SurfaceResult;
  readonly "surface.close": SurfaceResult;
  readonly "surface.navigate": BrowserActionResult;
  readonly "surface.reload": BrowserActionResult;
  readonly "surface.goBack": BrowserActionResult;
  readonly "surface.goForward": BrowserActionResult;
  readonly "surface.stop": BrowserActionResult;
  readonly "surface.snapshot": SnapshotResult;
  readonly "surface.screenshot": ScreenshotResult;
  readonly "surface.wait": WaitResult;
  readonly "surface.text": TextResult;
  readonly "surface.html": HtmlResult;
  readonly "surface.title": TitleResult;
  readonly "surface.evaluate": EvaluateResult;
  readonly "surface.find": FindResult;
  readonly "surface.click": BrowserActionResult;
  readonly "surface.fill": BrowserActionResult;
  readonly "surface.type": BrowserActionResult;
  readonly "surface.press": BrowserActionResult;
  readonly "surface.select": BrowserActionResult;
  readonly "surface.scroll": BrowserActionResult;
  readonly "surface.hover": BrowserActionResult;
  readonly "surface.console": ConsoleResult;
  readonly "surface.cookies": CookiesResult;
  readonly [method: string]: BrowserResultBase;
  readonly "surface.storage": StorageResult;
  readonly "surface.downloads": DownloadsResult;
  readonly "surface.setBounds": SurfaceResult;
  readonly "surface.setMuted": SurfaceResult;
  readonly "surface.setOmnibarVisible": SurfaceResult;
  readonly "surface.focusAddressBar": SurfaceResult;
  readonly "surface.focusWebView": SurfaceResult;
  readonly "surface.restore": BrowserActionResult;
}
export type BrowserResult<M extends BrowserMethod = BrowserMethod> = BrowserResultMap[M];
export type BrowserIpcResult<M extends BrowserMethod = BrowserMethod> = BrowserResult<M>;

export interface BrowserCall {
  readonly version: typeof BROWSER_IPC_VERSION;
  readonly method: BrowserMethod;
  readonly request: BrowserRequestMap[BrowserMethod];
  /** Required by the native runtime for every surface-scoped operation. */
  readonly ownerSessionId?: OwnerSessionId;
}
export interface BrowserReply<M extends BrowserMethod = BrowserMethod> {
  readonly version: typeof BROWSER_IPC_VERSION;
  readonly ok: true;
  readonly method: M;
  readonly result: BrowserResultMap[M];
}
export interface BrowserFailure {
  readonly version: typeof BROWSER_IPC_VERSION;
  readonly ok: false;
  readonly method: BrowserMethod;
  readonly error: BrowserError;
}
export type BrowserResponse<M extends BrowserMethod = BrowserMethod> = BrowserReply<M> | BrowserFailure;
export type BrowserCallError = BrowserError;
export type BrowserCallResult<M extends BrowserMethod = BrowserMethod> = BrowserResult<M>;

const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ITEMS = 256;
const MAX_STRING_BYTES = 16_384;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_ELEMENTS = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SURFACE_PATTERN = /^surface:([1-9][0-9]{0,8})$/u;
const ELEMENT_PATTERN = /^@e([1-9][0-9]{0,8})$/u;
const OWNER_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class BrowserProtocolError extends Error {
  readonly code: BrowserErrorCode = "invalid_params";
  constructor(message: string) {
    super(message);
    this.name = "BrowserProtocolError";
  }
}
export type BrowserDecodeError = BrowserProtocolError;

function fail(message: string): never {
  throw new BrowserProtocolError(message);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length > MAX_OBJECT_KEYS) fail(`${path} has too many keys`);
  return result;
}
function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`${path}.${key} is not supported`);
}
function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1F || codePoint === 0x7F)) return true;
  }
  return false;
}
function boundedString(value: unknown, path: string, max = MAX_STRING_BYTES, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || utf8ByteLength(value) > max || hasAsciiControlCharacter(value)) fail(`${path} must be bounded text`);
  return value;
}
function boundedNumber(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) fail(`${path} is out of bounds`);
  return value;
}
function boundedBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be boolean`);
  return value;
}
function boundedArray(value: unknown, path: string, max = MAX_ARRAY_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${path} must be a bounded array`);
  return value;
}
function validateJson(value: unknown, path = "value", depth = 0, seen = new WeakSet<object>()): BrowserJsonValue {
  if (depth > 8) fail(`${path} is too deeply nested`);
  if (typeof value === "string") return boundedString(value, path, MAX_STRING_BYTES, false);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    boundedNumber(value, path, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return value;
  }
  if (typeof value !== "object") fail(`${path} is not JSON`);
  if (seen.has(value)) fail(`${path} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) return boundedArray(value, path).map((entry, index) => validateJson(entry, `${path}[${index}]`, depth + 1, seen));
  const input = record(value, path);
  const output: Record<string, BrowserJsonValue> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (isSecretLikeKey(key)) fail(`${path}.${key} is not allowed`);
    output[key] = validateJson(entry, `${path}.${key}`, depth + 1, seen);
  }
  return output;
}
function validateTotal(value: unknown): void {
  let bytes = 0;
  const visit = (item: unknown): void => {
    if (typeof item === "string") bytes += utf8ByteLength(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item !== null && typeof item === "object") Object.entries(item).forEach(([key, child]) => { bytes += utf8ByteLength(key); visit(child); });
    if (bytes > MAX_INPUT_BYTES) fail("value exceeds protocol size limit");
  };
  visit(value);
}
function url(value: unknown, path: string): string {
  const text = boundedString(value, path, 2_048);
  let parsed: URL;
  try { parsed = new URL(text); } catch { fail(`${path} must be a valid URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "about:") fail(`${path} uses an unsupported URL scheme`);
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.username !== "" || parsed.password !== "")) fail(`${path} must not contain credentials`);
  return parsed.toString();
}
function surfaceId(value: unknown, path = "surfaceId"): SurfaceId {
  const text = boundedString(value, path, 64);
  if (!UUID_PATTERN.test(text)) fail(`${path} must be a UUID`);
  return text as SurfaceId;
}
function ownerSessionId(value: unknown, path = "ownerSessionId"): OwnerSessionId {
  const text = boundedString(value, path, 128);
  if (!OWNER_SESSION_ID_PATTERN.test(text)) fail(`${path} must be a bounded session identifier`);
  return text as OwnerSessionId;
}
function handle(value: unknown, path = "handle"): SurfaceHandle {
  const text = boundedString(value, path, 32);
  if (!SURFACE_PATTERN.test(text)) fail(`${path} must be a surface handle`);
  return text as SurfaceHandle;
}
function elementRef(value: unknown, path = "ref"): ElementRef {
  const text = boundedString(value, path, 32);
  if (!ELEMENT_PATTERN.test(text)) fail(`${path} must be an element reference`);
  return text as ElementRef;
}
function bounds(value: unknown, path = "bounds"): BrowserBounds {
  const input = record(value, path);
  exact(input, ["x", "y", "width", "height"], path);
  return {
    x: boundedNumber(input.x, `${path}.x`, -32_768, 32_768, true),
    y: boundedNumber(input.y, `${path}.y`, -32_768, 32_768, true),
    width: boundedNumber(input.width, `${path}.width`, 1, 8_192, true),
    height: boundedNumber(input.height, `${path}.height`, 1, 8_192, true),
  };
}
function profile(value: unknown, path = "profile"): BrowserProfile {
  const input = record(value, path);
  if (input.kind === "isolated-session") {
    exact(input, ["kind", "profileId"], path);
    if (input.profileId !== "isolated-session") fail(`${path}.profileId must be isolated-session`);
    return { kind: "isolated-session", profileId: "isolated-session" };
  }
  if (input.kind === "authenticated-profile") {
    exact(input, ["kind", "profileId", "explicitOptIn"], path);
    if (input.explicitOptIn !== true) fail(`${path}.explicitOptIn must be true`);
    return { kind: "authenticated-profile", profileId: boundedString(input.profileId, `${path}.profileId`, 256), explicitOptIn: true };
  }
  fail(`${path}.kind is invalid`);
}
function surface(value: unknown, path = "surface"): BrowserSurfaceState {
  const input = record(value, path);
  exact(input, ["surfaceId", "handle", "profile", "url", "title", "faviconUrl", "lifecycle", "readyState", "loading", "progress", "canGoBack", "canGoForward", "bounds", "visible", "muted", "focused", "createdAt", "updatedAt"], path);
  const lifecycle = input.lifecycle;
  if (lifecycle !== "creating" && lifecycle !== "loading" && lifecycle !== "ready" && lifecycle !== "closed" && lifecycle !== "crashed" && lifecycle !== "failed") fail(`${path}.lifecycle is invalid`);
  const readyState = input.readyState;
  if (readyState !== "loading" && readyState !== "interactive" && readyState !== "complete") fail(`${path}.readyState is invalid`);
  const focused = input.focused;
  if (focused !== "address" && focused !== "webview" && focused !== "none") fail(`${path}.focused is invalid`);
  return {
    surfaceId: surfaceId(input.surfaceId, `${path}.surfaceId`), handle: handle(input.handle, `${path}.handle`), profile: profile(input.profile, `${path}.profile`),
    url: url(input.url, `${path}.url`), title: boundedString(input.title, `${path}.title`, 4_096, false),
    ...(input.faviconUrl === undefined ? {} : { faviconUrl: url(input.faviconUrl, `${path}.faviconUrl`) }),
    lifecycle, readyState, loading: boundedBoolean(input.loading, `${path}.loading`), progress: boundedNumber(input.progress, `${path}.progress`, 0, 1),
    canGoBack: boundedBoolean(input.canGoBack, `${path}.canGoBack`), canGoForward: boundedBoolean(input.canGoForward, `${path}.canGoForward`), bounds: bounds(input.bounds, `${path}.bounds`), visible: boundedBoolean(input.visible, `${path}.visible`), muted: boundedBoolean(input.muted, `${path}.muted`), focused,
    createdAt: boundedNumber(input.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER), updatedAt: boundedNumber(input.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}
function snapshotElement(value: unknown, path: string): BrowserSnapshotElement {
  const input = record(value, path); exact(input, ["ref", "role", "name", "value", "text", "bounds", "disabled", "checked", "expanded"], path);
  return {
    ref: elementRef(input.ref, `${path}.ref`), role: boundedString(input.role, `${path}.role`, 256), name: boundedString(input.name, `${path}.name`, 1_024),
    ...(input.value === undefined ? {} : { value: boundedString(input.value, `${path}.value`, 4_096, false) }), ...(input.text === undefined ? {} : { text: boundedString(input.text, `${path}.text`, 4_096, false) }),
    ...(input.bounds === undefined ? {} : { bounds: bounds(input.bounds, `${path}.bounds`) }), ...(input.disabled === undefined ? {} : { disabled: boundedBoolean(input.disabled, `${path}.disabled`) }), ...(input.checked === undefined ? {} : { checked: boundedBoolean(input.checked, `${path}.checked`) }), ...(input.expanded === undefined ? {} : { expanded: boundedBoolean(input.expanded, `${path}.expanded`) }),
  };
}
function snapshot(value: unknown, path = "snapshot"): BrowserSnapshot {
  const input = record(value, path); exact(input, ["surfaceId", "handle", "url", "title", "readyState", "viewport", "elements", "capturedAt", "truncated"], path);
  const elements = boundedArray(input.elements, `${path}.elements`, MAX_ELEMENTS).map((item, index) => snapshotElement(item, `${path}.elements[${index}]`));
  const readyState = input.readyState;
  if (readyState !== "loading" && readyState !== "interactive" && readyState !== "complete") fail(`${path}.readyState is invalid`);
  return { surfaceId: surfaceId(input.surfaceId, `${path}.surfaceId`), handle: handle(input.handle, `${path}.handle`), url: url(input.url, `${path}.url`), title: boundedString(input.title, `${path}.title`, 4_096, false), readyState, viewport: bounds(input.viewport, `${path}.viewport`), elements, capturedAt: boundedNumber(input.capturedAt, `${path}.capturedAt`, 0, Number.MAX_SAFE_INTEGER), ...(input.truncated === undefined ? {} : { truncated: boundedBoolean(input.truncated, `${path}.truncated`) }) };
}
function idRequest(value: unknown, keys: readonly string[] = ["surfaceId"]): SurfaceIdRequest {
  const input = record(value, "request"); exact(input, keys, "request"); return { surfaceId: surfaceId(input.surfaceId) };
}
function actionOptions(input: Record<string, unknown>): BrowserActionOptions { return input.snapshotAfter === undefined ? {} : { snapshotAfter: boundedBoolean(input.snapshotAfter, "request.snapshotAfter") }; }
function target(input: Record<string, unknown>, path = "request"): { ref?: ElementRef; selector?: string } {
  if (input.ref === undefined && input.selector === undefined) fail(`${path} requires ref or selector`);
  if (input.ref !== undefined && input.selector !== undefined) fail(`${path} accepts only one target`);
  return input.ref === undefined ? { selector: boundedString(input.selector, `${path}.selector`, 1_024) } : { ref: elementRef(input.ref, `${path}.ref`) };
}

export function decodeBrowserMethod(value: unknown): BrowserMethod {
  const method = boundedString(value, "method", 128);
  if (!(BROWSER_METHODS as readonly string[]).includes(method)) fail("unsupported browser method");
  return method as BrowserMethod;
}
export function decodeBrowserRequest<M extends BrowserMethod>(method: M, value: unknown): BrowserRequestMap[M] {
  validateTotal(value);
  const input = record(value, "request");
  switch (method) {
    case "surface.create": { exact(input, ["profile", "url", "bounds", "visible"], "request"); return { profile: profile(input.profile), ...(input.url === undefined ? {} : { url: url(input.url, "request.url") }), ...(input.bounds === undefined ? {} : { bounds: bounds(input.bounds) }), ...(input.visible === undefined ? {} : { visible: boundedBoolean(input.visible, "request.visible") }) } as BrowserRequestMap[M]; }
    case "surface.list": exact(input, [], "request"); return {} as BrowserRequestMap[M];
    case "surface.get": case "surface.close": return idRequest(value) as BrowserRequestMap[M];
    case "surface.navigate": { exact(input, ["surfaceId", "url", "snapshotAfter"], "request"); return { surfaceId: surfaceId(input.surfaceId), url: url(input.url, "request.url"), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.reload": case "surface.goBack": case "surface.goForward": case "surface.stop": case "surface.focusAddressBar": case "surface.focusWebView": { exact(input, ["surfaceId", "snapshotAfter"], "request"); return { ...idRequest(input), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.snapshot": { exact(input, ["surfaceId", "includeText"], "request"); return { surfaceId: surfaceId(input.surfaceId), ...(input.includeText === undefined ? {} : { includeText: boundedBoolean(input.includeText, "request.includeText") }) } as BrowserRequestMap[M]; }
    case "surface.screenshot": { exact(input, ["surfaceId", "bounds", "format", "quality"], "request"); if (input.format !== undefined && input.format !== "png" && input.format !== "jpeg") fail("request.format is invalid"); return { surfaceId: surfaceId(input.surfaceId), ...(input.bounds === undefined ? {} : { bounds: bounds(input.bounds) }), ...(input.format === undefined ? {} : { format: input.format }), ...(input.quality === undefined ? {} : { quality: boundedNumber(input.quality, "request.quality", 0, 100, true) }) } as BrowserRequestMap[M]; }
    case "surface.wait": { exact(input, ["surfaceId", "selector", "state", "timeoutMs"], "request"); if (input.state !== undefined && !["visible", "hidden", "attached", "detached"].includes(input.state as string)) fail("request.state is invalid"); return { surfaceId: surfaceId(input.surfaceId), ...(input.selector === undefined ? {} : { selector: boundedString(input.selector, "request.selector", 1_024) }), ...(input.state === undefined ? {} : { state: input.state }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: boundedNumber(input.timeoutMs, "request.timeoutMs", 0, 120_000, true) }) } as BrowserRequestMap[M]; }
    case "surface.text": case "surface.html": { exact(input, ["surfaceId", "ref", "selector"], "request"); return { surfaceId: surfaceId(input.surfaceId), ...target(input) } as BrowserRequestMap[M]; }
    case "surface.title": { exact(input, ["surfaceId"], "request"); return idRequest(input) as BrowserRequestMap[M]; }
    case "surface.evaluate": { exact(input, ["surfaceId", "expression", "args"], "request"); return { surfaceId: surfaceId(input.surfaceId), expression: boundedString(input.expression, "request.expression", 32_768), ...(input.args === undefined ? {} : { args: boundedArray(input.args, "request.args").map((item, index) => validateJson(item, `request.args[${index}]`)) }) } as BrowserRequestMap[M]; }
    case "surface.find": { exact(input, ["surfaceId", "query", "limit"], "request"); return { surfaceId: surfaceId(input.surfaceId), query: boundedString(input.query, "request.query", 1_024), ...(input.limit === undefined ? {} : { limit: boundedNumber(input.limit, "request.limit", 1, MAX_ELEMENTS, true) }) } as BrowserRequestMap[M]; }
    case "surface.click": { exact(input, ["surfaceId", "ref", "selector", "button", "clickCount", "snapshotAfter"], "request"); const button = input.button === undefined ? undefined : input.button; if (button !== undefined && button !== "left" && button !== "middle" && button !== "right") fail("request.button is invalid"); return { surfaceId: surfaceId(input.surfaceId), ...target(input), ...(button === undefined ? {} : { button }), ...(input.clickCount === undefined ? {} : { clickCount: boundedNumber(input.clickCount, "request.clickCount", 1, 3, true) }), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.fill": { exact(input, ["surfaceId", "ref", "selector", "value", "snapshotAfter"], "request"); return { surfaceId: surfaceId(input.surfaceId), ...target(input), value: boundedString(input.value, "request.value", 16_384, false), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.type": { exact(input, ["surfaceId", "ref", "selector", "text", "intervalMs", "snapshotAfter"], "request"); return { surfaceId: surfaceId(input.surfaceId), text: boundedString(input.text, "request.text", 16_384, false), ...(input.ref === undefined && input.selector === undefined ? {} : target(input)), ...(input.intervalMs === undefined ? {} : { intervalMs: boundedNumber(input.intervalMs, "request.intervalMs", 0, 10_000, true) }), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.press": { exact(input, ["surfaceId", "key", "modifiers", "snapshotAfter"], "request"); const modifiers = input.modifiers === undefined ? undefined : boundedArray(input.modifiers, "request.modifiers", 4).map((item, index) => { const modifier = boundedString(item, `request.modifiers[${index}]`, 16); if (!["Alt", "Control", "Meta", "Shift"].includes(modifier)) fail(`request.modifiers[${index}] is invalid`); return modifier as "Alt" | "Control" | "Meta" | "Shift"; }); return { surfaceId: surfaceId(input.surfaceId), key: boundedString(input.key, "request.key", 128), ...(modifiers === undefined ? {} : { modifiers }), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.select": { exact(input, ["surfaceId", "ref", "selector", "values", "snapshotAfter"], "request"); return { surfaceId: surfaceId(input.surfaceId), ...target(input), values: boundedArray(input.values, "request.values", 64).map((item, index) => boundedString(item, `request.values[${index}]`, 1_024, false)), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.scroll": case "surface.hover": { exact(input, ["surfaceId", "ref", "selector", "x", "y", "snapshotAfter"], "request"); return { surfaceId: surfaceId(input.surfaceId), ...(input.ref === undefined && input.selector === undefined ? {} : target(input)), ...(input.x === undefined ? {} : { x: boundedNumber(input.x, "request.x", -32_768, 32_768, true) }), ...(input.y === undefined ? {} : { y: boundedNumber(input.y, "request.y", -32_768, 32_768, true) }), ...actionOptions(input) } as BrowserRequestMap[M]; }
    case "surface.console": { exact(input, ["surfaceId", "levels"], "request"); const levels = input.levels === undefined ? undefined : boundedArray(input.levels, "request.levels", 5).map((item, index) => { const level = boundedString(item, `request.levels[${index}]`, 16); if (!["debug", "info", "log", "warn", "error"].includes(level)) fail(`request.levels[${index}] is invalid`); return level as BrowserConsoleLevel; }); return { surfaceId: surfaceId(input.surfaceId), ...(levels === undefined ? {} : { levels }) } as BrowserRequestMap[M]; }
    case "surface.cookies": { exact(input, ["surfaceId", "operation", "url"], "request"); if (input.operation !== "get" && input.operation !== "clear") fail("request.operation is invalid"); return { surfaceId: surfaceId(input.surfaceId), operation: input.operation, ...(input.url === undefined ? {} : { url: url(input.url, "request.url") }) } as BrowserRequestMap[M]; }
    case "surface.storage": { exact(input, ["surfaceId", "operation", "storageArea", "key"], "request"); if (input.operation !== "get" && input.operation !== "clear") fail("request.operation is invalid"); if (input.storageArea !== undefined && input.storageArea !== "local" && input.storageArea !== "session") fail("request.storageArea is invalid"); return { surfaceId: surfaceId(input.surfaceId), operation: input.operation, ...(input.storageArea === undefined ? {} : { storageArea: input.storageArea }), ...(input.key === undefined ? {} : { key: boundedString(input.key, "request.key", 512) }) } as BrowserRequestMap[M]; }
    case "surface.downloads": exact(input, ["surfaceId"], "request"); return idRequest(input) as BrowserRequestMap[M];
    case "surface.setBounds": { exact(input, ["surfaceId", "bounds", "visible"], "request"); return { surfaceId: surfaceId(input.surfaceId), bounds: bounds(input.bounds), ...(input.visible === undefined ? {} : { visible: boundedBoolean(input.visible, "request.visible") }) } as BrowserRequestMap[M]; }
    case "surface.setMuted": { exact(input, ["surfaceId", "muted"], "request"); return { surfaceId: surfaceId(input.surfaceId), muted: boundedBoolean(input.muted, "request.muted") } as BrowserRequestMap[M]; }
    case "surface.setOmnibarVisible": { exact(input, ["surfaceId", "visible"], "request"); return { surfaceId: surfaceId(input.surfaceId), visible: boundedBoolean(input.visible, "request.visible") } as BrowserRequestMap[M]; }
    case "surface.restore": { exact(input, ["surfaceId", "url"], "request"); return { surfaceId: surfaceId(input.surfaceId), ...(input.url === undefined ? {} : { url: url(input.url, "request.url") }) } as BrowserRequestMap[M]; }
  }
  return validateJson(input, "request") as BrowserRequestMap[M];
}

export function decodeBrowserCall(value: unknown): BrowserCall {
  validateTotal(value);
  const input = record(value, "call"); exact(input, ["version", "method", "request", "ownerSessionId"], "call");
  if (input.version !== BROWSER_IPC_VERSION) fail("unsupported browser IPC version");
  const method = decodeBrowserMethod(input.method);
  const owner = input.ownerSessionId === undefined ? undefined : ownerSessionId(input.ownerSessionId, "call.ownerSessionId");
  return {
    version: BROWSER_IPC_VERSION,
    method,
    request: decodeBrowserRequest(method, input.request),
    ...(owner === undefined ? {} : { ownerSessionId: owner }),
  };
}

export function decodeBrowserEvent(value: unknown): BrowserEvent {
  validateTotal(value);
  const input = record(value, "event"); exact(input, ["type", "surface", "download", "console", "error", "ownerSessionId"], "event");
  const owner = input.ownerSessionId === undefined ? {} : { ownerSessionId: ownerSessionId(input.ownerSessionId, "event.ownerSessionId") };
  if (input.type === "state") { exact(input, ["type", "surface", "ownerSessionId"], "event"); return { type: "state", surface: surface(input.surface), ...owner }; }
  if (input.type === "download") { exact(input, ["type", "download", "ownerSessionId"], "event"); return { type: "download", download: decodeBrowserDownload(input.download), ...owner }; }
  if (input.type === "console") { exact(input, ["type", "console", "ownerSessionId"], "event"); return { type: "console", console: decodeBrowserConsole(input.console), ...owner }; }
  if (input.type === "error") { exact(input, ["type", "error", "ownerSessionId"], "event"); return { type: "error", error: decodeBrowserRuntimeError(input.error), ...owner }; }
  fail("event.type is invalid");
}
function decodeBrowserDownload(value: unknown): BrowserDownload {
  const input = record(value, "download"); exact(input, ["downloadId", "surfaceId", "state", "url", "filename", "mimeType", "totalBytes", "receivedBytes", "savePath", "failure"], "download");
  if (!["started", "progress", "completed", "cancelled", "failed"].includes(input.state as string)) fail("download.state is invalid");
  return { downloadId: boundedString(input.downloadId, "download.downloadId", 256), surfaceId: surfaceId(input.surfaceId, "download.surfaceId"), state: input.state as BrowserDownloadState, url: url(input.url, "download.url"), filename: boundedString(input.filename, "download.filename", 512), ...(input.mimeType === undefined ? {} : { mimeType: boundedString(input.mimeType, "download.mimeType", 256) }), ...(input.totalBytes === undefined ? {} : { totalBytes: boundedNumber(input.totalBytes, "download.totalBytes", 0, Number.MAX_SAFE_INTEGER, true) }), ...(input.receivedBytes === undefined ? {} : { receivedBytes: boundedNumber(input.receivedBytes, "download.receivedBytes", 0, Number.MAX_SAFE_INTEGER, true) }), ...(input.savePath === undefined ? {} : { savePath: boundedString(input.savePath, "download.savePath", 4_096) }), ...(input.failure === undefined ? {} : { failure: boundedString(input.failure, "download.failure", 2_048) }) };
}
function decodeBrowserConsole(value: unknown): BrowserConsoleMessage {
  const input = record(value, "console"); exact(input, ["level", "message", "args", "source", "url", "line", "column", "timestamp", "surfaceId"], "console");
  if (!["debug", "info", "log", "warn", "error"].includes(input.level as string)) fail("console.level is invalid");
  return { level: input.level as BrowserConsoleLevel, message: boundedString(input.message, "console.message", 16_384, false), args: boundedArray(input.args, "console.args").map((item, index) => validateJson(item, `console.args[${index}]`)), ...(input.source === undefined ? {} : { source: boundedString(input.source, "console.source", 2_048) }), ...(input.url === undefined ? {} : { url: url(input.url, "console.url") }), ...(input.line === undefined ? {} : { line: boundedNumber(input.line, "console.line", 0, Number.MAX_SAFE_INTEGER, true) }), ...(input.column === undefined ? {} : { column: boundedNumber(input.column, "console.column", 0, Number.MAX_SAFE_INTEGER, true) }), timestamp: boundedNumber(input.timestamp, "console.timestamp", 0, Number.MAX_SAFE_INTEGER), surfaceId: surfaceId(input.surfaceId, "console.surfaceId") };
}
function decodeBrowserRuntimeError(value: unknown): BrowserRuntimeError {
  const input = record(value, "error"); exact(input, ["surfaceId", "kind", "code", "message", "url", "fatal", "timestamp"], "error");
  if (!["page", "navigation", "renderer", "certificate", "security", "download"].includes(input.kind as string)) fail("error.kind is invalid");
  return { surfaceId: surfaceId(input.surfaceId, "error.surfaceId"), kind: input.kind as BrowserRuntimeErrorKind, code: boundedString(input.code, "error.code", 128), message: boundedString(input.message, "error.message", 4_096, false), ...(input.url === undefined ? {} : { url: url(input.url, "error.url") }), fatal: boundedBoolean(input.fatal, "error.fatal"), timestamp: boundedNumber(input.timestamp, "error.timestamp", 0, Number.MAX_SAFE_INTEGER) };
}

function actionResult(value: unknown, path = "result"): BrowserActionResult {
  const input = record(value, path);
  exact(input, ["surface", "postActionSnapshot"], path);
  return {
    surface: surface(input.surface, `${path}.surface`),
    ...(input.postActionSnapshot === undefined ? {} : { postActionSnapshot: snapshot(input.postActionSnapshot, `${path}.postActionSnapshot`) }),
  };
}
export function decodeBrowserResult<M extends BrowserMethod>(method: M, value: unknown): BrowserResultMap[M] {
  validateTotal(value);
  switch (method) {
    case "surface.create": {
      const input = record(value, "result"); exact(input, ["surface", "snapshot"], "result");
      return { surface: surface(input.surface), ...(input.snapshot === undefined ? {} : { snapshot: snapshot(input.snapshot) }) } as BrowserResultMap[M];
    }
    case "surface.list": {
      const input = record(value, "result"); exact(input, ["surfaces"], "result");
      return { surfaces: boundedArray(input.surfaces, "result.surfaces").map((item, index) => surface(item, `result.surfaces[${index}]`)) } as BrowserResultMap[M];
    }
    case "surface.get": case "surface.close": case "surface.setBounds": case "surface.setMuted": case "surface.setOmnibarVisible": case "surface.focusAddressBar": case "surface.focusWebView": {
      const input = record(value, "result"); exact(input, ["surface"], "result");
      return { surface: surface(input.surface) } as BrowserResultMap[M];
    }
    case "surface.navigate": case "surface.reload": case "surface.goBack": case "surface.goForward": case "surface.stop": case "surface.click": case "surface.fill": case "surface.type": case "surface.press": case "surface.select": case "surface.scroll": case "surface.hover": case "surface.restore":
      return actionResult(value) as BrowserResultMap[M];
    case "surface.snapshot": {
      const input = record(value, "result"); exact(input, ["snapshot"], "result");
      return { snapshot: snapshot(input.snapshot) } as BrowserResultMap[M];
    }
    case "surface.screenshot": {
      const input = record(value, "result"); exact(input, ["mimeType", "width", "height", "data"], "result");
      if (input.mimeType !== "image/png" && input.mimeType !== "image/jpeg") fail("result.mimeType is invalid");
      return { mimeType: input.mimeType, width: boundedNumber(input.width, "result.width", 1, 8_192, true), height: boundedNumber(input.height, "result.height", 1, 8_192, true), data: boundedString(input.data, "result.data", MAX_INPUT_BYTES) } as BrowserResultMap[M];
    }
    case "surface.wait": {
      const input = record(value, "result"); exact(input, ["surface", "postActionSnapshot", "matched"], "result");
      return { ...actionResult(input), matched: boundedBoolean(input.matched, "result.matched") } as BrowserResultMap[M];
    }
    case "surface.text": { const input = record(value, "result"); exact(input, ["text"], "result"); return { text: boundedString(input.text, "result.text", 32_768, false) } as BrowserResultMap[M]; }
    case "surface.html": { const input = record(value, "result"); exact(input, ["html"], "result"); return { html: boundedString(input.html, "result.html", MAX_INPUT_BYTES, false) } as BrowserResultMap[M]; }
    case "surface.title": { const input = record(value, "result"); exact(input, ["title", "url"], "result"); return { title: boundedString(input.title, "result.title", 4_096, false), url: url(input.url, "result.url") } as BrowserResultMap[M]; }
    case "surface.evaluate": { const input = record(value, "result"); exact(input, ["value"], "result"); return { value: validateJson(input.value, "result.value") } as BrowserResultMap[M]; }
    case "surface.find": { const input = record(value, "result"); exact(input, ["elements"], "result"); return { elements: boundedArray(input.elements, "result.elements", MAX_ELEMENTS).map((item, index) => snapshotElement(item, `result.elements[${index}]`)) } as BrowserResultMap[M]; }
    case "surface.console": { const input = record(value, "result"); exact(input, ["messages"], "result"); return { messages: boundedArray(input.messages, "result.messages").map((item) => decodeBrowserConsole(item)) } as BrowserResultMap[M]; }
    case "surface.cookies": { const input = record(value, "result"); exact(input, ["count"], "result"); return { count: boundedNumber(input.count, "result.count", 0, MAX_ARRAY_ITEMS, true) } as BrowserResultMap[M]; }
    case "surface.storage": { const input = record(value, "result"); exact(input, ["entries"], "result"); const entries = record(input.entries, "result.entries"); const decoded: Record<string, string> = {}; for (const [key, item] of Object.entries(entries)) { if (isSecretLikeKey(key)) fail(`result.entries.${key} is not allowed`); decoded[key] = boundedString(item, `result.entries.${key}`, MAX_STRING_BYTES, false); } return { entries: decoded } as BrowserResultMap[M]; }
    case "surface.downloads": { const input = record(value, "result"); exact(input, ["downloads"], "result"); return { downloads: boundedArray(input.downloads, "result.downloads").map((item) => decodeBrowserDownload(item)) } as BrowserResultMap[M]; }
    default: return validateJson(record(value, "result"), "result") as BrowserResultMap[M];
  }
}

export function decodeBrowserResponse(value: unknown): BrowserResponse {
  validateTotal(value);
  const input = record(value, "response"); exact(input, ["version", "ok", "method", "result", "error"], "response");
  if (input.version !== BROWSER_IPC_VERSION) fail("unsupported browser IPC version");
  const method = decodeBrowserMethod(input.method);
  if (input.ok === false) {
    exact(input, ["version", "ok", "method", "error"], "response");
    const error = record(input.error, "response.error"); exact(error, ["code", "message", "method", "surfaceId", "retryable", "details"], "response.error");
    if (!["invalid_params", "not_found", "invalid_state", "not_supported", "timeout", "security", "internal"].includes(error.code as string)) fail("response.error.code is invalid");
    return { version: BROWSER_IPC_VERSION, ok: false, method, error: { code: error.code as BrowserErrorCode, message: boundedString(error.message, "response.error.message", 4_096, false), ...(error.method === undefined ? {} : { method: decodeBrowserMethod(error.method) }), ...(error.surfaceId === undefined ? {} : { surfaceId: surfaceId(error.surfaceId, "response.error.surfaceId") }), ...(error.retryable === undefined ? {} : { retryable: boundedBoolean(error.retryable, "response.error.retryable") }), ...(error.details === undefined ? {} : { details: validateJson(error.details, "response.error.details") as Readonly<Record<string, BrowserJsonValue>> }) } };
  }
  if (input.ok !== true) fail("response.ok must be boolean");
  exact(input, ["version", "ok", "method", "result"], "response");
  return { version: BROWSER_IPC_VERSION, ok: true, method, result: decodeBrowserResult(method, input.result) };
}

export function browserError(code: BrowserErrorCode, message: string, method?: BrowserMethod): BrowserError {
  return { code, message: boundedString(message, "message", 4_096, false), ...(method === undefined ? {} : { method }) };
}
