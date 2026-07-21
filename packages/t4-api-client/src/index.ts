import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "./generated/schema.ts";

export type { components, operations, paths } from "./generated/schema.ts";

const MAX_CREDENTIAL_LENGTH = 4096;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const CURSOR_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const ERROR_CODES = {
  invalid_request: true, unauthenticated: true, forbidden: true, not_found: true,
  idempotency_key_required: true, idempotency_conflict: true, revision_conflict: true,
  incompatible_version: true, cursor_expired: true, unavailable: true, indeterminate: true,
  invalid_origin: true, https_required: true,
} as const satisfies Record<components["schemas"]["ApiError"]["code"], true>;
const ERROR_FIELDS: Record<string, true> = {
  code: true, message: true, requestId: true, retryable: true,
  violations: true, supportedMajors: true, resync: true,
};
const SESSION_STATES = {
  accepted: true, provisioning: true, ready: true, cancelling: true,
  cancelled: true, failed: true, unavailable: true, indeterminate: true,
} as const satisfies Record<components["schemas"]["SessionState"], true>;
const OPERATION_STATES = {
  accepted: true, rejected: true, conflict: true, unavailable: true, indeterminate: true,
} as const satisfies Record<components["schemas"]["OperationState"], true>;

type ApiError = components["schemas"]["ApiError"];
type Resync = components["schemas"]["Resync"];
type WatchEvent = components["schemas"]["WatchEvent"];

export interface T4ApiClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly majorVersion: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface WatchSessionOptions {
  readonly cursor?: components["schemas"]["Cursor"];
  readonly maxEvents?: number;
  readonly heartbeatSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface T4ApiClient {
  readonly http: Client<paths>;
  watchSession(sessionId: string, options?: WatchSessionOptions): AsyncGenerator<WatchEvent, void, undefined>;
}

export class T4ApiError extends Error {
  readonly code: ApiError["code"];
  readonly status: number;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly violations?: ApiError["violations"];
  readonly supportedMajors?: ApiError["supportedMajors"];
  readonly resync?: Resync;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "T4ApiError";
    this.code = error.code;
    this.status = status;
    this.requestId = error.requestId;
    this.retryable = error.retryable;
    if (error.violations !== undefined) this.violations = error.violations;
    if (error.supportedMajors !== undefined) this.supportedMajors = error.supportedMajors;
    if (error.resync !== undefined) this.resync = error.resync;
  }
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("T4 API baseUrl must be an absolute HTTPS URL", { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("T4 API baseUrl must be a credential-free HTTPS URL without query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function requiredCredential(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_CREDENTIAL_LENGTH ||
    !/^[A-Za-z0-9._~+/-]+=*$/u.test(value)
  ) {
    throw new TypeError("credential must be an opaque bearer token of at most 4096 characters");
  }
  return value;
}

function requiredMajor(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) {
    throw new TypeError("majorVersion must be an integer between 1 and 9999");
  }
  return String(value);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

function requiredSessionId(value: string): string {
  if (value.length < 1 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value)) {
    throw new TypeError("sessionId is invalid");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validViolation(value: unknown): boolean {
  const violation = record(value);
  return violation !== undefined &&
    Object.keys(violation).every((key) => key === "field" || key === "rule" || key === "message") &&
    typeof violation.field === "string" && violation.field.length >= 1 && violation.field.length <= 256 &&
    typeof violation.rule === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(violation.rule) &&
    typeof violation.message === "string" && violation.message.length >= 1 && violation.message.length <= 512;
}

function validResync(value: unknown): value is Resync {
  const resync = record(value);
  return resync !== undefined && Object.keys(resync).every((key) => key === "snapshotUrl" || key === "cursor") &&
    typeof resync.snapshotUrl === "string" && /^\/v1\/sessions\/[A-Za-z0-9._~-]+\/snapshot$/u.test(resync.snapshotUrl) &&
    typeof resync.cursor === "string" && resync.cursor.length <= 512 && CURSOR_PATTERN.test(resync.cursor);
}

function apiError(value: unknown): ApiError | undefined {
  const envelope = record(value);
  const error = record(envelope?.error);
  if (
    envelope === undefined || Object.keys(envelope).some((key) => key !== "error") ||
    error === undefined || Object.keys(error).some((key) => ERROR_FIELDS[key] !== true) ||
    typeof error.code !== "string" || ERROR_CODES[error.code as ApiError["code"]] !== true ||
    typeof error.message !== "string" || error.message.length < 1 || error.message.length > 1024 ||
    typeof error.requestId !== "string" || error.requestId.length < 1 || error.requestId.length > 128 ||
    typeof error.retryable !== "boolean" ||
    (error.violations !== undefined && (!Array.isArray(error.violations) || error.violations.length > 64 || !error.violations.every(validViolation))) ||
    (error.supportedMajors !== undefined && (!Array.isArray(error.supportedMajors) || error.supportedMajors.length > 8 || !error.supportedMajors.every((major) => Number.isSafeInteger(major) && Number(major) >= 1))) ||
    (error.resync !== undefined && !validResync(error.resync))
  ) return undefined;
  return error as ApiError;
}

async function boundedResponseText(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_ERROR_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}

async function boundedError(response: Response): Promise<T4ApiError> {
  const text = await boundedResponseText(response);
  if (text !== undefined) {
    try {
      const decoded = apiError(JSON.parse(text));
      if (decoded !== undefined) return new T4ApiError(response.status, decoded);
    } catch {
      // Fall through to the stable indeterminate transport envelope.
    }
  }
  return new T4ApiError(response.status, {
    code: response.status === 503 ? "unavailable" : "indeterminate",
    message: "T4 API returned an invalid or oversized error envelope",
    requestId: "unavailable",
    retryable: response.status >= 500,
  });
}

function watchEvent(value: unknown, eventId: string | undefined): WatchEvent {
  const event = record(value);
  if (
    event === undefined ||
    typeof event.type !== "string" ||
    typeof event.cursor !== "string" ||
    event.cursor.length < 1 ||
    event.cursor.length > 512 ||
    !CURSOR_PATTERN.test(event.cursor) ||
    (eventId !== undefined && eventId !== event.cursor)
  ) throw new T4ApiError(502, { code: "indeterminate", message: "T4 API returned an invalid watch event", requestId: "unavailable", retryable: true });
  if (event.type === "heartbeat" && typeof event.observedAt === "string" && event.observedAt.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(event.observedAt) && Number.isFinite(Date.parse(event.observedAt))) {
    return event as WatchEvent;
  }
  if (
    event.type === "session" &&
    typeof event.state === "string" &&
    SESSION_STATES[event.state as components["schemas"]["SessionState"]] === true &&
    Number.isSafeInteger(event.revision) && Number(event.revision) >= 1
  ) return event as WatchEvent;
  if (
    event.type === "command" &&
    typeof event.commandId === "string" &&
    event.commandId.length >= 1 && event.commandId.length <= 128 &&
    typeof event.state === "string" &&
    OPERATION_STATES[event.state as components["schemas"]["OperationState"]] === true
  ) return event as WatchEvent;
  throw new T4ApiError(502, { code: "indeterminate", message: "T4 API returned an invalid watch event", requestId: "unavailable", retryable: true });
}

function decodeSseFrame(frame: string): WatchEvent | undefined {
  let eventId: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split(/\r\n|\r|\n/u)) {
    const line = rawLine;
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") eventId = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  try {
    return watchEvent(JSON.parse(data.join("\n")), eventId);
  } catch (error) {
    if (error instanceof T4ApiError) throw error;
    throw new T4ApiError(502, { code: "indeterminate", message: "T4 API returned malformed SSE data", requestId: "unavailable", retryable: true });
  }
}

function nextSseBoundary(buffer: string): { readonly index: number; readonly length: number } | undefined {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/u.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

async function* watch(
  baseUrl: string,
  credential: string,
  majorVersion: string,
  fetchImpl: typeof globalThis.fetch,
  sessionIdValue: string,
  options: WatchSessionOptions,
): AsyncGenerator<WatchEvent, void, undefined> {
  const sessionId = requiredSessionId(sessionIdValue);
  const maxEvents = boundedInteger(options.maxEvents, 100, 1, 1000, "maxEvents");
  const heartbeatSeconds = boundedInteger(options.heartbeatSeconds, 15, 5, 60, "heartbeatSeconds");
  if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 512 || !CURSOR_PATTERN.test(options.cursor))) {
    throw new TypeError("cursor must be a header-safe token containing between 1 and 512 characters");
  }
  const url = new URL(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`);
  url.searchParams.set("maxEvents", String(maxEvents));
  url.searchParams.set("heartbeatSeconds", String(heartbeatSeconds));
  if (options.cursor !== undefined) url.searchParams.set("cursor", options.cursor);
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers = new Headers({
      Accept: "text/event-stream",
      Authorization: `Bearer ${credential}`,
      "Cache-Control": "no-store",
      "T4-API-Version": majorVersion,
    });
    if (options.cursor !== undefined) headers.set("Last-Event-ID", options.cursor);
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) throw await boundedError(response);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new T4ApiError(502, { code: "indeterminate", message: "T4 API watch did not return text/event-stream", requestId: "unavailable", retryable: true });
    }
    if (response.body === null) {
      throw new T4ApiError(502, { code: "indeterminate", message: "T4 API watch response body is unavailable", requestId: "unavailable", retryable: true });
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let delivered = 0;
    while (delivered < maxEvents) {
      if (controller.signal.aborted) return;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > MAX_EVENT_BYTES) {
        throw new T4ApiError(502, { code: "indeterminate", message: "T4 API watch event exceeds the client bound", requestId: "unavailable", retryable: true });
      }
      let boundary = nextSseBoundary(buffer);
      while (boundary !== undefined && delivered < maxEvents) {
        if (controller.signal.aborted) return;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = decodeSseFrame(frame);
        if (event !== undefined) {
          delivered += 1;
          yield event;
          if (controller.signal.aborted) return;
        }
        boundary = nextSseBoundary(buffer);
      }
    }
    if (buffer.trim().length > 0 && delivered < maxEvents) {
      const event = decodeSseFrame(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    if (reader !== undefined) {
      try { await reader.cancel(); } catch { /* cancellation is best effort */ }
    }
  }
}

export function createT4ApiClient(options: T4ApiClientOptions): T4ApiClient {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const credential = requiredCredential(options.credential);
  const majorVersion = requiredMajor(options.majorVersion);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("Authorization", `Bearer ${credential}`);
    request.headers.set("T4-API-Version", majorVersion);
    request.headers.set("Accept", "application/json");
    return await fetchImpl(request);
  };
  const http = createClient<paths>({ baseUrl, fetch: authenticatedFetch });
  return Object.freeze({
    http,
    watchSession: (sessionId: string, watchOptions: WatchSessionOptions = {}) =>
      watch(baseUrl, credential, majorVersion, fetchImpl, sessionId, watchOptions),
  });
}
