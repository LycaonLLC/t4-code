import { ipcRenderer } from "electron";
import { BrowserDomAutomationError, executeBrowserDomAutomation, resetBrowserDomAutomation } from "./browser-dom-automation.ts";
import { BROWSER_CONTENT_REQUEST_CHANNEL, BROWSER_CONTENT_RESPONSE_CHANNEL } from "./browser-content-channels.ts";

const MAX_ID_BYTES = 128;
const MAX_METHOD_BYTES = 128;
const MAX_PARAMS_BYTES = 256 * 1024;
const MAX_PARAMS_DEPTH = 8;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_EVENT_ITEMS = 32;
const MAX_EVENT_KEYS = 64;

type ErrorCode = "invalid_params" | "not_found" | "invalid_state" | "not_supported" | "timeout" | "security" | "internal";
type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

interface ContentRequest {
  readonly requestId: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface ContentSuccess {
  readonly requestId: string;
  readonly ok: true;
  readonly result: JsonValue;
}

interface ContentFailure {
  readonly requestId: string | null;
  readonly ok: false;
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

interface ContentEvent {
  readonly requestId: null;
  readonly event: { readonly type: "console" | "error"; readonly payload: JsonValue };
}

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function boundedString(value: string, maxBytes = MAX_STRING_BYTES): string {
  if (byteLength(value) <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, depth: number, seen: WeakSet<object>): value is JsonValue {
  if (depth > MAX_PARAMS_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1, seen));
    const record = value as Record<string, unknown>;
    return Object.keys(record).every((key) => isJsonValue(record[key], depth + 1, seen));
  } finally {
    seen.delete(value);
  }
}

function serializeParams(params: Record<string, unknown>): string | undefined {
  if (!isJsonValue(params, 0, new WeakSet<object>())) return undefined;
  try {
    const serialized = JSON.stringify(params);
    return serialized !== undefined && byteLength(serialized) <= MAX_PARAMS_BYTES ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function requestIdFrom(value: unknown): string | null {
  return typeof value === "string" && byteLength(value) <= MAX_ID_BYTES ? value : null;
}

function validateRequest(value: unknown): ContentRequest | ContentFailure {
  if (!isRecord(value)) return invalidRequest(null);
  const requestId = requestIdFrom(value.requestId);
  const method = value.method;
  const params = value.params;
  if (requestId === null) return invalidRequest(null);
  if (typeof method !== "string" || byteLength(method) > MAX_METHOD_BYTES) return invalidRequest(requestId);
  if (!isRecord(params) || serializeParams(params) === undefined) return invalidRequest(requestId);
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => key === "requestId" || key === "method" || key === "params")) return invalidRequest(requestId);
  return { requestId, method, params };
}

function invalidRequest(requestId: string | null): ContentFailure {
  return { requestId, ok: false, error: { code: "invalid_params", message: "Invalid content request envelope" } };
}

function safeJson(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return boundedString(value.toString());
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return boundedString(String(value));
  if (depth >= 8) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: boundedString(value.name),
        message: boundedString(value.message),
        ...(value.stack === undefined ? {} : { stack: boundedString(value.stack) }),
      };
    }
    if (Array.isArray(value)) return value.slice(0, MAX_EVENT_ITEMS).map((item) => safeJson(item, depth + 1, seen));
    const output: Record<string, JsonValue> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).slice(0, MAX_EVENT_KEYS)) {
      try {
        output[boundedString(key)] = safeJson(record[key], depth + 1, seen);
      } catch {
        output[boundedString(key)] = "[unavailable]";
      }
    }
    return output;
  } catch {
    return "[unserializable]";
  } finally {
    seen.delete(value);
  }
}

function boundedEventPayload(value: unknown): JsonValue {
  const payload = safeJson(value);
  try {
    if (byteLength(JSON.stringify(payload)) <= MAX_EVENT_BYTES) return payload;
  } catch {
    // Fall through to a deterministic bounded value.
  }
  return { truncated: true };
}

function send(value: ContentSuccess | ContentFailure | ContentEvent): void {
  try {
    ipcRenderer.send(BROWSER_CONTENT_RESPONSE_CHANNEL, value);
  } catch {
    // The receiving WebContents can disappear while a page event is in flight.
  }
}

function metadata(): JsonValue {
  return {
    title: boundedString(document.title),
    url: boundedString(document.URL),
    readyState: document.readyState,
    charset: boundedString(document.characterSet),
  };
}

async function dispatch(request: ContentRequest): Promise<ContentSuccess | ContentFailure> {
  if (request.method === "content.ping") {
    return { requestId: request.requestId, ok: true, result: { pong: true } };
  }
  if (request.method === "content.document_metadata") {
    return { requestId: request.requestId, ok: true, result: metadata() };
  }
  try {
    const result = await executeBrowserDomAutomation(request.method, request.params);
    return { requestId: request.requestId, ok: true, result: safeJson(result) };
  } catch (error) {
    if (error instanceof BrowserDomAutomationError) {
      return { requestId: request.requestId, ok: false, error: { code: error.code, message: boundedString(error.message, MAX_STRING_BYTES) } };
    }
    return { requestId: request.requestId, ok: false, error: { code: "internal", message: "Content request failed" } };
  }
}

async function handleRequest(value: unknown): Promise<void> {
  let request: ContentRequest | ContentFailure;
  try {
    request = validateRequest(value);
  } catch {
    send(invalidRequest(null));
    return;
  }
  if ("method" in request) {
    send(await dispatch(request));
  } else {
    send(request);
  }
}


function emitEvent(type: "console" | "error", payload: unknown): void {
  send({ requestId: null, event: { type, payload: boundedEventPayload(payload) } });
}

function installPageObservers(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("error", (event) => {
    emitEvent("error", {
      kind: "error",
      message: boundedString(event.message),
      filename: boundedString(event.filename),
      lineno: event.lineno,
      colno: event.colno,
      ...(event.error === undefined ? {} : { error: safeJson(event.error) }),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    emitEvent("error", { kind: "unhandledrejection", reason: safeJson(event.reason) });
  });

  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      emitEvent("console", { level, args: args.slice(0, MAX_EVENT_ITEMS).map((arg) => safeJson(arg)) });
      original.apply(console, args);
    };
  }
}

ipcRenderer.on(BROWSER_CONTENT_REQUEST_CHANNEL, (_event, value: unknown) => { void handleRequest(value); });
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => resetBrowserDomAutomation(), { once: true });
  window.addEventListener("pageshow", () => resetBrowserDomAutomation());
}
installPageObservers();
