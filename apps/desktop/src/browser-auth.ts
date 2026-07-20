import type { AuthInfo, WebContents } from "electron";

type BrowserCancelableEvent = { readonly preventDefault: () => void };

const MAX_QUEUE = 32;
const MAX_TEXT_BYTES = 512;
const MAX_URL_BYTES = 8_192;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BrowserAuthChallenge {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly realm: string;
  readonly scheme: string;
  readonly isProxy: boolean;
  readonly retry: boolean;
}

export interface BrowserAuthCredentials {
  readonly username: string;
  readonly password: string;
}

export interface BrowserAuthControllerOptions {
  readonly resolve: (challenge: BrowserAuthChallenge) => Promise<BrowserAuthCredentials | null | undefined>;
  readonly maxQueue?: number;
  readonly timeoutMs?: number;
}

export interface BrowserAuthController {
  readonly handleLogin: BrowserAuthLoginHandler;
  clear(): void;
  dispose(): void;
}

export type BrowserAuthLoginHandler = (
  event: BrowserCancelableEvent,
  webContents: WebContents,
  details: { readonly url: string },
  authInfo: AuthInfo,
  callback: (username?: string, password?: string) => void,
) => void;

type Pending = {
  readonly challenge: BrowserAuthChallenge;
  readonly callback: (username?: string, password?: string) => void;
};

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: string, max = MAX_TEXT_BYTES): string | null {
  return typeof value === "string" && value.length > 0 && bytes(value) <= max ? value : null;
}

function challengeFrom(details: { readonly url: string }, info: AuthInfo): BrowserAuthChallenge | null {
  const url = boundedText(details.url, MAX_URL_BYTES);
  const host = boundedText(info.host);
  const realm = typeof info.realm === "string" && bytes(info.realm) <= MAX_TEXT_BYTES ? info.realm : "";
  const scheme = boundedText(info.scheme, 64);
  if (!url || !host || !scheme || !Number.isInteger(info.port) || info.port < 0 || info.port > 65_535) return null;
  return {
    url,
    host: host.toLowerCase(),
    port: info.port,
    realm,
    scheme: scheme.toLowerCase(),
    isProxy: info.isProxy === true,
    retry: false,
  };
}

function safeCallback(callback: (username?: string, password?: string) => void, credentials?: BrowserAuthCredentials): void {
  try {
    if (!credentials) {
      callback();
      return;
    }
    const username = boundedText(credentials.username);
    const password = boundedText(credentials.password);
    if (!username || !password) callback();
    else callback(username, password);
  } catch {
    try { callback(); } catch { /* Electron callbacks can be invalid after teardown. */ }
  }
}

/**
 * Serializes HTTP Basic challenges so a renderer cannot create an unbounded set
 * of credential prompts. The resolver is the only component that sees secrets;
 * this module never logs, emits, or persists credentials.
 */
export function createBrowserAuthController(options: BrowserAuthControllerOptions): BrowserAuthController {
  const requestedQueue = Number.isFinite(options.maxQueue) ? Math.trunc(options.maxQueue as number) : MAX_QUEUE;
  const requestedTimeout = Number.isFinite(options.timeoutMs) ? Math.trunc(options.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  const maxQueue = Math.max(1, Math.min(MAX_QUEUE, requestedQueue));
  const timeoutMs = Math.max(1_000, Math.min(120_000, requestedTimeout));
  const queue: Pending[] = [];
  const seen = new Set<string>();
  let running = false;
  let disposed = false;

  const drain = (): void => {
    if (running || disposed) return;
    const pending = queue.shift();
    if (!pending) return;
    running = true;
    let settled = false;
    const finish = (credentials?: BrowserAuthCredentials | null): void => {
      if (settled) return;
      settled = true;
      safeCallback(pending.callback, disposed ? undefined : credentials ?? undefined);
      running = false;
      drain();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    void Promise.resolve()
      .then(() => options.resolve(pending.challenge))
      .then((credentials) => {
        clearTimeout(timer);
        finish(credentials);
      }, () => {
        clearTimeout(timer);
        finish();
      });
  };

  const handleLogin: BrowserAuthLoginHandler = (event, _webContents, details, authInfo, callback) => {
    event.preventDefault();
    if (disposed) {
      safeCallback(callback);
      return;
    }
    const challenge = challengeFrom(details, authInfo);
    if (!challenge || queue.length >= maxQueue || (running && queue.length >= maxQueue - 1)) {
      safeCallback(callback);
      return;
    }
    const key = `${challenge.isProxy ? "proxy" : "server"}|${challenge.host}|${challenge.port}|${challenge.realm}|${challenge.scheme}`;
    const retry = seen.has(key);
    if (seen.size < MAX_QUEUE * 2) seen.add(key);
    queue.push({ challenge: { ...challenge, retry }, callback });
    drain();
  };
  return {
    handleLogin,
    clear(): void {
      while (queue.length) safeCallback(queue.shift()!.callback);
      seen.clear();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      while (queue.length) safeCallback(queue.shift()!.callback);
      seen.clear();
    },
  };
}


export const createBrowserBasicAuthController = createBrowserAuthController;
