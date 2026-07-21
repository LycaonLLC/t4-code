import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "./generated/schema.ts";

export type { components, operations, paths } from "./generated/schema.ts";

const MAX_CREDENTIAL_LENGTH = 4096;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const SESSION_STATES = new Set<components["schemas"]["SessionState"]>([
  "accepted",
  "provisioning",
  "ready",
  "cancelling",
  "cancelled",
  "failed",
  "unavailable",
  "indeterminate",
]);
const OPERATION_STATES = new Set<components["schemas"]["OperationState"]>([
  "accepted",
  "rejected",
  "conflict",
  "unavailable",
  "indeterminate",
]);

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

function apiError(value: unknown): ApiError | undefined {
  const envelope = record(value);
  const error = record(envelope?.error);
  if (
    error === undefined ||
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    typeof error.requestId !== "string" ||
    typeof error.retryable !== "boolean"
  ) return undefined;
  return error as ApiError;
}

async function boundedError(response: Response): Promise<T4ApiError> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength <= MAX_ERROR_BYTES) {
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
    (eventId !== undefined && eventId !== event.cursor)
  ) throw new T4ApiError(502, { code: "indeterminate", message: "T4 API returned an invalid watch event", requestId: "unavailable", retryable: true });
  if (event.type === "heartbeat" && typeof event.observedAt === "string" && event.observedAt.length <= 64) {
    return event as WatchEvent;
  }
  if (
    event.type === "session" &&
    typeof event.state === "string" &&
    SESSION_STATES.has(event.state as components["schemas"]["SessionState"]) &&
    Number.isSafeInteger(event.revision) && Number(event.revision) >= 1
  ) return event as WatchEvent;
  if (
    event.type === "command" &&
    typeof event.commandId === "string" &&
    event.commandId.length >= 1 && event.commandId.length <= 128 &&
    typeof event.state === "string" &&
    OPERATION_STATES.has(event.state as components["schemas"]["OperationState"])
  ) return event as WatchEvent;
  throw new T4ApiError(502, { code: "indeterminate", message: "T4 API returned an invalid watch event", requestId: "unavailable", retryable: true });
}

function decodeSseFrame(frame: string): WatchEvent | undefined {
  let eventId: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
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
  if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 512)) {
    throw new TypeError("cursor must contain between 1 and 512 characters");
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
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0 && delivered < maxEvents) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = decodeSseFrame(frame);
        if (event !== undefined) {
          delivered += 1;
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
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
