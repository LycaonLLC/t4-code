import { randomUUID } from "node:crypto";
import { ipcMain as electronIpcMain, type IpcMain, type IpcMainEvent, type Session, type WebContents } from "electron";
import type {
  BrowserCall,
  BrowserCallResult,
  BrowserConsoleLevel,
  BrowserConsoleMessage,
  BrowserErrorCode,
  BrowserEvent,
  BrowserJsonValue,
  BrowserMethod,
  BrowserRuntimeError,
  SurfaceId,
} from "@t4-code/protocol/browser-ipc";
import { BROWSER_CONTENT_REQUEST_CHANNEL, BROWSER_CONTENT_RESPONSE_CHANNEL } from "./browser-content-channels.ts";

const MAX_PENDING = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RING_ITEMS = 256;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 8;
const MAX_COOKIE_ITEMS = 256;
const MAX_DOWNLOAD_ID_BYTES = 256;
const MAX_SCRIPT_BYTES = 256 * 1024;

export interface BrowserAutomationSurface {
  readonly surfaceId: SurfaceId | string;
  readonly webContents: WebContents;
  readonly browserSession: Session;
  readonly waitForContentReady: (timeoutMs: number) => Promise<void>;
}

export interface BrowserAutomationDownloads {
  readonly wait: (downloadId: string, timeoutMs?: number) => Promise<unknown>;
  readonly owns?: (downloadId: string) => boolean;
  readonly list?: (surfaceId?: SurfaceId) => readonly { readonly downloadId?: unknown }[];
}

export interface BrowserAutomationOptions {
  readonly ipcMain?: Pick<IpcMain, "on" | "removeListener">;
  readonly resolveSurface: (surfaceId?: string) => BrowserAutomationSurface | undefined;
  readonly downloads?: BrowserAutomationDownloads;
  readonly emit?: (event: BrowserEvent) => void;
}


interface ContentEvent {
  readonly requestId: null;
  readonly event: { readonly type?: unknown; readonly payload?: unknown };
}


interface PendingCall {
  readonly surface: BrowserAutomationSurface;
  readonly contents: WebContents;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CookieLike {
  readonly name?: unknown;
  readonly value?: unknown;
  readonly domain?: unknown;
  readonly path?: unknown;
  readonly secure?: unknown;
  readonly httpOnly?: unknown;
  readonly sameSite?: unknown;
  readonly expirationDate?: unknown;
  readonly session?: unknown;
  readonly url?: unknown;
}

class BrowserAutomationError extends Error {
  readonly code: BrowserErrorCode;
  readonly method: BrowserMethod | undefined;

  constructor(code: BrowserErrorCode, message: string, method?: BrowserMethod) {
    super(boundString(message, 4_096));
    this.name = "BrowserAutomationError";
    this.code = code;
    this.method = method;
  }
}

const CONTENT_METHODS = new Set<string>([
  "browser.navigate", "browser.back", "browser.forward", "browser.reload",
  "browser.snapshot", "browser.eval", "browser.wait", "browser.screenshot",
  "browser.click", "browser.dblclick", "browser.hover", "browser.focus",
  "browser.type", "browser.fill", "browser.press", "browser.keydown", "browser.keyup",
  "browser.check", "browser.uncheck", "browser.select", "browser.scroll", "browser.scroll_into_view",
  "browser.get.text", "browser.get.html", "browser.get.value", "browser.get.attr", "browser.get.count",
  "browser.get.box", "browser.get.styles", "browser.get.title", "browser.is.visible",
  "browser.is.enabled", "browser.is.checked", "browser.find.role", "browser.find.text",
  "browser.find.label", "browser.find.placeholder", "browser.find.testid", "browser.find.first",
  "browser.find.last", "browser.find.nth", "browser.highlight", "browser.frame.select", "browser.frame.main",
  "browser.storage.get", "browser.storage.set", "browser.storage.clear",
  "browser.design_mode.set", "browser.design_mode.status",
]);

const SPECIAL_METHODS = new Set<string>([
  "browser.cookies.get", "browser.cookies.set", "browser.cookies.clear",
  "browser.console.list", "browser.console.clear", "browser.console.show", "browser.errors.list",
  "browser.state.save", "browser.state.load", "browser.addinitscript", "browser.addscript", "browser.addstyle",
  "browser.download.wait",
]);

const MUTATING_METHODS = new Set<string>([
  "browser.navigate", "browser.back", "browser.forward", "browser.reload", "browser.click", "browser.dblclick",
  "browser.hover", "browser.focus", "browser.type", "browser.fill", "browser.press", "browser.keydown",
  "browser.keyup", "browser.check", "browser.uncheck", "browser.select", "browser.scroll", "browser.scroll_into_view",
  "browser.highlight", "browser.frame.select", "browser.frame.main", "browser.storage.set", "browser.storage.clear",
  "browser.cookies.set", "browser.cookies.clear", "browser.state.load", "browser.addinitscript", "browser.addscript",
  "browser.addstyle", "browser.design_mode.set",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundString(value: string, maxBytes = MAX_STRING_BYTES): string {
  if (byteLength(value) <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

function boundValue(value: unknown, depth = 0, seen = new WeakSet<object>()): BrowserJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return boundString(value.toString());
  if (typeof value !== "object") return boundString(String(value));
  if (depth >= MAX_DEPTH || seen.has(value)) return "[redacted]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => boundValue(entry, depth + 1, seen));
    const result: Record<string, BrowserJsonValue> = {};
    for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) result[boundString(key)] = boundValue((value as Record<string, unknown>)[key], depth + 1, seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

function boundEventValue(value: unknown, depth = 0, seen = new WeakSet<object>()): BrowserJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value !== "object") return boundString(String(value));
  if (depth >= MAX_DEPTH || seen.has(value)) return "[redacted]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => boundEventValue(entry, depth + 1, seen));
    const result: Record<string, BrowserJsonValue> = {};
    for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
      const boundedKey = boundString(key);
      result[boundedKey] = /cookie/iu.test(key) ? "[redacted]" : boundEventValue((value as Record<string, unknown>)[key], depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function boundedResult(value: unknown): unknown {
  const result = boundValue(value);
  try {
    if (byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES) return result;
  } catch {
    // Use the deterministic bounded value below.
  }
  return { truncated: true };
}

function requestRecord(call: BrowserCall): Record<string, unknown> {
  if (!isRecord(call.request)) throw new BrowserAutomationError("invalid_params", "Browser request must be an object", call.method);
  return call.request;
}

function surfaceIdFrom(request: Record<string, unknown>): string | undefined {
  return typeof request.surfaceId === "string" && request.surfaceId.length > 0 ? boundString(request.surfaceId, 256) : undefined;
}

function errorCode(value: unknown): BrowserErrorCode {
  if (value === "invalid_params" || value === "not_found" || value === "invalid_state" || value === "not_supported" || value === "timeout" || value === "security" || value === "internal") return value;
  return "internal";
}

function payloadMessage(value: unknown): string {
  if (typeof value === "string") return boundString(value);
  if (isRecord(value)) {
    if (typeof value.message === "string") return boundString(value.message);
    if (typeof value.reason === "string") return boundString(value.reason);
  }
  try { return boundString(JSON.stringify(boundValue(value)) ?? ""); } catch { return ""; }
}

function level(value: unknown): BrowserConsoleLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "log";
}

function secretCookieName(name: string): boolean {
  return /(?:token|secret|password|credential|authorization|session|cookie|key)/iu.test(name);
}

function safeCookie(cookie: CookieLike, surfaceId: SurfaceId): Record<string, BrowserJsonValue> {
  const name = typeof cookie.name === "string" ? boundString(cookie.name, 512) : "";
  const value = typeof cookie.value === "string" ? (secretCookieName(name) ? "[redacted]" : boundString(cookie.value)) : "";
  const output: Record<string, BrowserJsonValue> = { name, value };
  for (const key of ["domain", "path", "sameSite", "url"] as const) {
    const candidate = cookie[key];
    if (typeof candidate === "string") output[key] = boundString(candidate, 2_048);
  }
  for (const key of ["secure", "httpOnly", "session"] as const) {
    if (typeof cookie[key] === "boolean") output[key] = cookie[key];
  }
  if (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)) output.expirationDate = cookie.expirationDate;
  output.surfaceId = surfaceId;
  return output;
}

function stripSurface(request: Record<string, unknown>): Record<string, unknown> {
  const { surfaceId: _surfaceId, snapshotAfter: _snapshotAfter, ...params } = request;
  return params;
}

function timeoutValue(request: Record<string, unknown>): number {
  const value = request.timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(0, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}
function evaluationExpression(request: Record<string, unknown>, method: BrowserMethod): string {
  const expression = request.expression;
  if (typeof expression !== "string" || byteLength(expression) > 64 * 1024) {
    throw new BrowserAutomationError("invalid_params", "Expression must be bounded text", method);
  }
  if (/\b(?:require|process|ipcRenderer|electron|module|exports|__dirname|__filename)\b/u.test(expression)) {
    throw new BrowserAutomationError("security", "Node and Electron objects are unavailable", method);
  }
  return expression;
}


function evaluationScript(expression: string, args: string, useArguments: boolean, statement = false): string {
  const bound = `const bound=(value,depth=0,seen=new WeakSet())=>{if(value===null||typeof value==="boolean")return value;if(typeof value==="string")return value.length>32768?value.slice(0,32768):value;if(typeof value==="number")return Number.isFinite(value)?value:null;if(typeof value==="undefined")return null;if(typeof value!=="object")return String(value).slice(0,32768);if(depth>=8||seen.has(value))return "[unavailable]";seen.add(value);try{if(Array.isArray(value))return value.slice(0,512).map((entry)=>bound(entry,depth+1,seen));const output={};for(const key of Object.keys(value).slice(0,128)){const boundedKey=String(key).slice(0,256);try{output[boundedKey]=bound(value[key],depth+1,seen)}catch{output[boundedKey]="[unavailable]"}}return output}catch{return "[unavailable]"}finally{seen.delete(value)}};`;
  const invoke = statement
    ? `await (async()=>{${expression}})()`
    : useArguments ? `((${expression})).apply(null,${args})` : `(${expression})`;
  return `(async()=>{${bound}try{return {ok:true,value:bound(await ${invoke})}}catch{return {ok:false,error:"Evaluation failed"}}})()`;
}

export function canHandleBrowserAutomationMethod(method: string): method is BrowserMethod {
  return CONTENT_METHODS.has(method) || SPECIAL_METHODS.has(method);
}

/** Coordinates browser worker automation with a surface-scoped preload bridge. */
export class BrowserAutomationCoordinator {
  private readonly ipc: Pick<IpcMain, "on" | "removeListener">;
  private readonly resolveSurface: BrowserAutomationOptions["resolveSurface"];
  private readonly downloads: BrowserAutomationDownloads | undefined;
  private readonly emitEvent: ((event: BrowserEvent) => void) | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private readonly knownSurfaces = new Map<string, BrowserAutomationSurface>();
  private readonly consoles = new Map<string, BrowserConsoleMessage[]>();
  private readonly errors = new Map<string, BrowserRuntimeError[]>();
  private disposed = false;

  public constructor(options: BrowserAutomationOptions) {
    this.ipc = options.ipcMain ?? electronIpcMain;
    this.resolveSurface = options.resolveSurface;
    this.downloads = options.downloads;
    this.emitEvent = options.emit;
    this.ipc.on(BROWSER_CONTENT_RESPONSE_CHANNEL, this.onContentResponse);
  }

  public async call(call: BrowserCall): Promise<BrowserCallResult> {
    if (this.disposed) throw new BrowserAutomationError("invalid_state", "Browser automation is disposed", call.method);
    if (!canHandleBrowserAutomationMethod(call.method)) throw new BrowserAutomationError("not_supported", `Browser method ${call.method} is not supported`, call.method);
    const request = requestRecord(call);
    const requestedSurfaceId = surfaceIdFrom(request);
    const surface = call.method === "browser.download.wait" && requestedSurfaceId === undefined
      ? undefined
      : this.surfaceFor(request, call.method);
    const mutation = MUTATING_METHODS.has(call.method);
    try {
    let result: unknown;
    switch (call.method) {
      case "browser.cookies.get": result = await this.cookiesGet(surface as BrowserAutomationSurface, request); break;
      case "browser.cookies.set": result = await this.cookiesSet(surface as BrowserAutomationSurface, request); break;
      case "browser.cookies.clear": result = await this.cookiesClear(surface as BrowserAutomationSurface, request); break;
      case "browser.console.list": result = this.consoleList((surface as BrowserAutomationSurface).surfaceId, request); break;
      case "browser.console.show": result = this.consoleList((surface as BrowserAutomationSurface).surfaceId, request); break;
      case "browser.console.clear": this.consoles.delete(String((surface as BrowserAutomationSurface).surfaceId)); result = { cleared: true }; break;
      case "browser.errors.list": result = { errors: [...(this.errors.get(String((surface as BrowserAutomationSurface).surfaceId)) ?? [])] }; break;
      case "browser.state.save": result = await this.stateSave(surface as BrowserAutomationSurface, request); break;
      case "browser.state.load": result = await this.stateLoad(surface as BrowserAutomationSurface, request); break;
      case "browser.addinitscript": result = await this.addInitScript(surface as BrowserAutomationSurface, request); break;
      case "browser.addscript": result = await this.addScript(surface as BrowserAutomationSurface, request); break;
      case "browser.addstyle": result = await this.addStyle(surface as BrowserAutomationSurface, request); break;
      case "browser.download.wait": result = await this.downloadWait(request); break;
      case "browser.eval": result = await this.evaluate(surface as BrowserAutomationSurface, request); break;
      case "browser.wait":
        result = (request.kind === "function" || (request.kind === undefined && request.type === "function"))
          ? await this.waitForFunction(surface as BrowserAutomationSurface, request)
          : await this.contentCall(surface as BrowserAutomationSurface, call.method, stripSurface(request));
        break;
      default: result = await this.contentCall(surface as BrowserAutomationSurface, call.method, stripSurface(request));
    }
    if (mutation && request.snapshotAfter === true) {
      if (isRecord(result) && "postActionSnapshot" in result) return boundedResult(result) as BrowserCallResult;
      const postActionSnapshot = await this.contentCall(surface as BrowserAutomationSurface, "browser.snapshot", {});
      if (isRecord(result)) return { ...result, postActionSnapshot: boundedResult(postActionSnapshot) } as BrowserCallResult;
      return { result: boundedResult(result), postActionSnapshot: boundedResult(postActionSnapshot) } as BrowserCallResult;
    }
    return boundedResult(result) as BrowserCallResult;
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      throw new BrowserAutomationError("internal", payloadMessage(error), call.method);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ipc.removeListener(BROWSER_CONTENT_RESPONSE_CHANNEL, this.onContentResponse);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BrowserAutomationError("invalid_state", "Browser automation is disposed"));
      this.pending.delete(requestId);
    }
    this.knownSurfaces.clear();
  }

  private surfaceFor(request: Record<string, unknown>, method: BrowserMethod): BrowserAutomationSurface {
    const surfaceId = surfaceIdFrom(request);
    const surface = this.resolveSurface(surfaceId);
    if (!surface) throw new BrowserAutomationError("not_found", "Browser surface is unavailable", method);
    this.knownSurfaces.set(String(surface.surfaceId), surface);
    return surface;
  }

  private async contentCall(surface: BrowserAutomationSurface, method: string, params: Record<string, unknown>): Promise<unknown> {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    if (this.disposed) throw new BrowserAutomationError("invalid_state", "Browser automation is disposed");
    if (this.pending.size >= MAX_PENDING) throw new BrowserAutomationError("invalid_state", "Too many pending browser requests");
    const contents = surface.webContents;

    try {
      await surface.waitForContentReady(Math.max(0, deadline - Date.now()));
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      const candidate = typeof error === "object" && error !== null
        ? error as { readonly code?: unknown; readonly message?: unknown }
        : undefined;
      const message = typeof candidate?.message === "string" ? candidate.message : payloadMessage(error);
      throw new BrowserAutomationError(errorCode(candidate?.code), message, method as BrowserMethod);
    }

    if (this.disposed) throw new BrowserAutomationError("invalid_state", "Browser automation is disposed");
    if (surface.webContents !== contents) throw new BrowserAutomationError("invalid_state", "Browser surface changed while preparing content request", method as BrowserMethod);
    if (this.pending.size >= MAX_PENDING) throw new BrowserAutomationError("invalid_state", "Too many pending browser requests");
    const remainingTimeout = deadline - Date.now();
    if (remainingTimeout <= 0) throw new BrowserAutomationError("timeout", "Browser content request timed out");

    const requestId = randomUUID();
    const boundedParams = boundedResult(params);
    const payload = { requestId, method: boundString(method, 128), params: isRecord(boundedParams) ? boundedParams : {} };
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject(new BrowserAutomationError("timeout", "Browser content request timed out"));
    }, remainingTimeout);
    this.pending.set(requestId, { surface, contents, resolve, reject, timer });
    try {
      contents.send(BROWSER_CONTENT_REQUEST_CHANNEL, payload);
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(requestId);
      reject(new BrowserAutomationError("internal", payloadMessage(error)));
    }
    return promise;
  }
  private async evaluate(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<{ value: BrowserJsonValue }> {
    const expression = evaluationExpression(request, "browser.eval");
    const args = Array.isArray(request.args) ? request.args : [];
    return { value: await this.evaluateOnSurface(surface, expression, args, Date.now() + timeoutValue(request), "browser.eval") };
  }

  private async waitForFunction(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<{ matched: true }> {
    const expression = evaluationExpression({ expression: request.value ?? request.selector }, "browser.wait");
    const args = Array.isArray(request.args) ? request.args : [];
    const deadline = Date.now() + timeoutValue(request);
    while (Date.now() <= deadline) {
      if (await this.evaluateOnSurface(surface, expression, args, deadline, "browser.wait")) return { matched: true };
      const delay = Math.min(25, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    throw new BrowserAutomationError("timeout", "Wait timed out", "browser.wait");
  }

  private async evaluateOnSurface(surface: BrowserAutomationSurface, expression: string, args: unknown[], deadline: number, method: BrowserMethod): Promise<BrowserJsonValue> {
    if (this.disposed) throw new BrowserAutomationError("invalid_state", "Browser automation is disposed", method);
    const contents = surface.webContents;
    if (contents.isDestroyed()) throw new BrowserAutomationError("invalid_state", "Browser surface is unavailable", method);
    const readyTimeout = deadline - Date.now();
    if (readyTimeout <= 0) throw new BrowserAutomationError("timeout", "Browser evaluation timed out", method);
    try {
      await surface.waitForContentReady(readyTimeout);
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      const candidate = typeof error === "object" && error !== null ? error as { readonly code?: unknown; readonly message?: unknown } : undefined;
      throw new BrowserAutomationError(errorCode(candidate?.code), typeof candidate?.message === "string" ? candidate.message : payloadMessage(error), method);
    }
    if (this.disposed) throw new BrowserAutomationError("invalid_state", "Browser automation is disposed", method);
    if (surface.webContents !== contents || contents.isDestroyed()) throw new BrowserAutomationError("invalid_state", "Browser surface changed while preparing evaluation", method);
    const serializedArgs = JSON.stringify(args.slice(0, MAX_ARRAY_ITEMS).map((value) => boundValue(value)));

    let result: unknown;
    try {
      result = await this.runEvaluationScript(surface, contents, evaluationScript(expression, serializedArgs, args.length > 0), deadline, method);
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      if (surface.webContents !== contents || contents.isDestroyed()) throw new BrowserAutomationError("invalid_state", "Browser surface changed while evaluating", method);
      try {
        result = await this.runEvaluationScript(surface, contents, evaluationScript(expression, serializedArgs, false, true), deadline, method);
      } catch (statementError) {
        if (statementError instanceof BrowserAutomationError) throw statementError;
        throw new BrowserAutomationError("internal", "Evaluation failed", method);
      }
    }
    if (!isRecord(result) || typeof result.ok !== "boolean") throw new BrowserAutomationError("internal", "Evaluation failed", method);
    if (result.ok !== true) throw new BrowserAutomationError("internal", "Evaluation failed", method);
    return boundValue(result.value);
  }

  private async runEvaluationScript(surface: BrowserAutomationSurface, contents: WebContents, script: string, deadline: number, method: BrowserMethod): Promise<unknown> {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new BrowserAutomationError("timeout", "Browser evaluation timed out", method);
    let timer: NodeJS.Timeout | undefined;
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      result = await Promise.race([
        contents.executeJavaScript(script, true),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserAutomationError("timeout", "Browser evaluation timed out", method)), timeout); }),
      ]);
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      clearTimeout(timer);
    }
    if (surface.webContents !== contents || contents.isDestroyed()) throw new BrowserAutomationError("invalid_state", "Browser surface changed while evaluating", method);
    if (failed) throw failure;
    return result;
  }

  private readonly onContentResponse = (event: IpcMainEvent, value: unknown): void => {
    if (this.disposed || !isRecord(value)) return;
    const requestId = value.requestId;
    if (requestId === null && isRecord(value.event)) {
      this.onContentEvent(event.sender, value as unknown as ContentEvent);
      return;
    }
    if (typeof requestId !== "string" || byteLength(requestId) > 128) return;
    const pending = this.pending.get(requestId);
    if (!pending || event.sender !== pending.contents) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (value.ok === true) {
      pending.resolve(boundedResult(value.result));
      return;
    }
    const error = isRecord(value.error) ? value.error : {};
    pending.reject(new BrowserAutomationError(errorCode(error.code), typeof error.message === "string" ? error.message : "Browser content request failed"));
  };

  private onContentEvent(sender: WebContents, response: ContentEvent): void {
    let surface: BrowserAutomationSurface | undefined;
    for (const candidate of this.knownSurfaces.values()) if (candidate.webContents === sender) { surface = candidate; break; }
    if (!surface) {
      const candidate = this.resolveSurface();
      if (candidate?.webContents === sender) {
        surface = candidate;
        this.knownSurfaces.set(String(candidate.surfaceId), candidate);
      }
    }
    if (!surface || !isRecord(response.event)) return;
    const type = response.event.type;
    if (type === "console") this.recordConsole(surface, response.event.payload);
    else if (type === "error") this.recordError(surface, response.event.payload);
  }

  private recordConsole(surface: BrowserAutomationSurface, payload: unknown): void {
    const object = isRecord(payload) ? payload : {};
    const args = Array.isArray(object.args) ? object.args.slice(0, 32).map((arg) => boundEventValue(arg)) : [];
    const message: BrowserConsoleMessage = {
      level: level(object.level),
      message: boundString(payloadMessage(object.message ?? (args.length > 0 ? args.map((arg) => payloadMessage(arg)).join(" ") : ""))),
      args,
      ...(typeof object.source === "string" ? { source: boundString(object.source, 2_048) } : {}),
      ...(typeof object.url === "string" ? { url: boundString(object.url, 2_048) } : {}),
      ...(typeof object.lineno === "number" && Number.isFinite(object.lineno) ? { line: Math.max(0, Math.trunc(object.lineno)) } : {}),
      ...(typeof object.colno === "number" && Number.isFinite(object.colno) ? { column: Math.max(0, Math.trunc(object.colno)) } : {}),
      timestamp: Date.now(),
      surfaceId: surface.surfaceId as SurfaceId,
    };
    const ring = this.consoles.get(String(surface.surfaceId)) ?? [];
    ring.push(message);
    if (ring.length > MAX_RING_ITEMS) ring.splice(0, ring.length - MAX_RING_ITEMS);
    this.consoles.set(String(surface.surfaceId), ring);
    try { this.emitEvent?.({ type: "console", console: message }); } catch { /* event listeners cannot interrupt the bridge */ }
  }

  private recordError(surface: BrowserAutomationSurface, payload: unknown): void {
    const object = isRecord(payload) ? payload : {};
    const error: BrowserRuntimeError = {
      surfaceId: surface.surfaceId as SurfaceId,
      kind: "page",
      code: typeof object.kind === "string" ? boundString(object.kind, 128) : "page",
      message: boundString(payloadMessage(object.message ?? object.reason ?? payload)),
      ...(typeof object.filename === "string" ? { url: boundString(object.filename, 2_048) } : {}),
      fatal: false,
      timestamp: Date.now(),
    };
    const ring = this.errors.get(String(surface.surfaceId)) ?? [];
    ring.push(error);
    if (ring.length > MAX_RING_ITEMS) ring.splice(0, ring.length - MAX_RING_ITEMS);
    this.errors.set(String(surface.surfaceId), ring);
    try { this.emitEvent?.({ type: "error", error }); } catch { /* event listeners cannot interrupt the bridge */ }
  }

  private consoleList(surfaceId: SurfaceId | string, request: Record<string, unknown>): { messages: readonly BrowserConsoleMessage[] } {
    const levels = Array.isArray(request.levels) ? new Set(request.levels.filter((item): item is BrowserConsoleLevel => item === "debug" || item === "info" || item === "log" || item === "warn" || item === "error")) : undefined;
    const messages = (this.consoles.get(String(surfaceId)) ?? []).filter((message) => levels === undefined || levels.has(message.level));
    return { messages: messages.slice(-MAX_RING_ITEMS) };
  }

  private async cookiesGet(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const url = typeof request.url === "string" ? boundString(request.url, 2_048) : undefined;
    const cookiesApi = surface.browserSession.cookies as unknown as { get: (filter: Record<string, unknown>) => Promise<readonly CookieLike[]> };
    const cookies = await cookiesApi.get(url === undefined ? {} : { url });
    return { cookies: cookies.slice(0, MAX_COOKIE_ITEMS).map((cookie) => safeCookie(cookie, surface.surfaceId as SurfaceId)), count: Math.min(cookies.length, MAX_COOKIE_ITEMS) };
  }

  private async cookiesSet(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const input = isRecord(request.cookie) ? request.cookie : request;
    const name = typeof input.name === "string" ? boundString(input.name, 512) : "";
    const value = typeof input.value === "string" ? boundString(input.value) : "";
    const url = typeof input.url === "string" ? boundString(input.url, 2_048) : undefined;
    if (!name || !url) throw new BrowserAutomationError("invalid_params", "Cookie name and url are required", "browser.cookies.set");
    const details: Record<string, unknown> = { url, name, value };
    for (const key of ["domain", "path", "sameSite"] as const) if (typeof input[key] === "string") details[key] = boundString(input[key] as string, 2_048);
    for (const key of ["secure", "httpOnly"] as const) if (typeof input[key] === "boolean") details[key] = input[key];
    if (typeof input.expirationDate === "number" && Number.isFinite(input.expirationDate)) details.expirationDate = input.expirationDate;
    const cookiesApi = surface.browserSession.cookies as unknown as { set: (details: Record<string, unknown>) => Promise<void> };
    await cookiesApi.set(details);
    return { count: 1 };
  }

  private async cookiesClear(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const url = typeof request.url === "string" ? boundString(request.url, 2_048) : undefined;
    const cookiesApi = surface.browserSession.cookies as unknown as { get: (filter: Record<string, unknown>) => Promise<readonly CookieLike[]>; remove: (url: string, name: string) => Promise<void> };
    const cookies = await cookiesApi.get(url === undefined ? {} : { url });
    let count = 0;
    for (const cookie of cookies.slice(0, MAX_COOKIE_ITEMS)) {
      if (typeof cookie.name !== "string") continue;
      const cookieUrl = typeof cookie.url === "string" ? cookie.url : url;
      if (!cookieUrl) continue;
      await cookiesApi.remove(boundString(cookieUrl, 2_048), boundString(cookie.name, 512));
      count += 1;
    }
    return { count };
  }

  private async stateSave(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const content = await this.contentCall(surface, "browser.state.save", stripSurface(request));
    const contentState = isRecord(content) && isRecord(content.state) ? content.state : isRecord(content) ? content : {};
    const currentUrl = (() => {
      try { return boundString(surface.webContents.getURL(), 2_048); } catch { return ""; }
    })();
    const state: Record<string, unknown> = {
      version: 1,
      url: currentUrl,
      localStorage: isRecord(contentState.localStorage) ? boundValue(contentState.localStorage) : {},
      sessionStorage: isRecord(contentState.sessionStorage) ? boundValue(contentState.sessionStorage) : {},
    };
    if (request.includeCookies === true || request.allowCookies === true) {
      const cookieResult = await this.cookiesGet(surface, request);
      if (isRecord(cookieResult) && Array.isArray(cookieResult.cookies)) state.cookies = cookieResult.cookies.slice(0, MAX_COOKIE_ITEMS);
    }
    return boundedResult(state);
  }

  private async stateLoad(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const state = isRecord(request.state) ? request.state : stripSurface(request);
    if (state.version !== 1) throw new BrowserAutomationError("invalid_params", "Browser state version must be 1", "browser.state.load");
    const currentUrl = (() => {
      try { return surface.webContents.getURL(); } catch { return ""; }
    })();
    const includeCookies = request.includeCookies === true || request.allowCookies === true;
    if (Array.isArray(state.cookies)) {
      if (!includeCookies) throw new BrowserAutomationError("security", "Loading cookies requires explicit opt-in", "browser.state.load");
      const hostname = (() => {
        try { return new URL(currentUrl).hostname.toLowerCase(); } catch { return ""; }
      })();
      const cookiesApi = surface.browserSession.cookies as unknown as { set: (details: Record<string, unknown>) => Promise<void> };
      for (const cookie of state.cookies.slice(0, MAX_COOKIE_ITEMS)) {
        if (!isRecord(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
          throw new BrowserAutomationError("invalid_params", "Invalid state cookie", "browser.state.load");
        }
        const domain = typeof cookie.domain === "string" ? cookie.domain.replace(/^\./u, "").toLowerCase() : "";
        if (!hostname || !domain || (hostname !== domain && !hostname.endsWith(`.${domain}`))) {
          throw new BrowserAutomationError("security", "State cookie domain does not match the current surface", "browser.state.load");
        }
        const cookieUrl = typeof cookie.url === "string" ? boundString(cookie.url, 2_048) : currentUrl;
        if (!cookieUrl) throw new BrowserAutomationError("invalid_params", "State cookie URL is required", "browser.state.load");
        await cookiesApi.set({
          url: cookieUrl,
          name: boundString(cookie.name, 512),
          value: boundString(cookie.value),
          domain,
          ...(typeof cookie.path === "string" ? { path: boundString(cookie.path, 2_048) } : {}),
          ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
          ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
          ...(typeof cookie.sameSite === "string" ? { sameSite: boundString(cookie.sameSite, 32) } : {}),
          ...(typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate) ? { expirationDate: cookie.expirationDate } : {}),
        });
      }
    }
    const contentState: Record<string, unknown> = {
      version: 1,
      ...(typeof state.url === "string" ? { url: boundString(state.url, 2_048) } : {}),
      localStorage: isRecord(state.localStorage) ? boundValue(state.localStorage) : {},
      sessionStorage: isRecord(state.sessionStorage) ? boundValue(state.sessionStorage) : {},
    };
    return boundedResult(await this.contentCall(surface, "browser.state.load", contentState));
  }

  private async addInitScript(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const script = typeof request.script === "string" ? request.script : typeof request.source === "string" ? request.source : "";
    if (!script || byteLength(script) > MAX_SCRIPT_BYTES) throw new BrowserAutomationError("invalid_params", "Script is required and bounded", "browser.addinitscript");
    const contents = surface.webContents as WebContents & { addInitScript?: (script: string) => Promise<void> | void };
    if (typeof contents.addInitScript !== "function") return this.contentCall(surface, "browser.addinitscript", { script: boundString(script, MAX_SCRIPT_BYTES) });
    await contents.addInitScript(script);
    return { added: true };
  }

  private async addScript(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const script = typeof request.script === "string" ? request.script : typeof request.source === "string" ? request.source : "";
    if (!script || byteLength(script) > MAX_SCRIPT_BYTES) throw new BrowserAutomationError("invalid_params", "Script is required and bounded", "browser.addscript");
    const result = await surface.webContents.executeJavaScript(script, true);
    return { value: boundedResult(result) };
  }

  private async addStyle(surface: BrowserAutomationSurface, request: Record<string, unknown>): Promise<unknown> {
    const css = typeof request.css === "string" ? request.css : typeof request.style === "string" ? request.style : "";
    if (!css || byteLength(css) > MAX_SCRIPT_BYTES) throw new BrowserAutomationError("invalid_params", "Style is required and bounded", "browser.addstyle");
    const contents = surface.webContents as WebContents & { insertCSS?: (css: string) => Promise<string> };
    if (typeof contents.insertCSS !== "function") throw new BrowserAutomationError("not_supported", "Style injection is not supported", "browser.addstyle");
    return { key: boundString(await contents.insertCSS(css), 256) };
  }

  private async downloadWait(request: Record<string, unknown>): Promise<unknown> {
    if (!this.downloads) throw new BrowserAutomationError("not_supported", "Download waiting is not configured", "browser.download.wait");
    const downloadId = typeof request.downloadId === "string" ? boundString(request.downloadId, MAX_DOWNLOAD_ID_BYTES) : "";
    if (!downloadId) throw new BrowserAutomationError("invalid_params", "downloadId is required", "browser.download.wait");
    const downloadOwned = this.downloads.owns?.(downloadId) === true
      || this.downloads.list?.().some((entry) => entry.downloadId === downloadId) === true;
    if (surfaceIdFrom(request) === undefined && !downloadOwned) {
      throw new BrowserAutomationError("not_found", "Download is not owned by this browser", "browser.download.wait");
    }
    const result = await this.downloads.wait(downloadId, timeoutValue(request));
    if (result === undefined) throw new BrowserAutomationError("timeout", "Download wait timed out", "browser.download.wait");
    return boundedResult(result);
  }
}
