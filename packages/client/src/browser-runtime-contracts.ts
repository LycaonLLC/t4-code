import type {
  BrowserCall,
  BrowserCallError,
  BrowserCallResult,
  BrowserEvent,
  BrowserMethod,
  BrowserProfile,
} from "@t4-code/protocol/browser-ipc";

function redactedBrowserMessage(message: string): string {
  const redacted = message
    .replace(/\b(?:https?|wss?|file):\/\/[^\r\n,;]*/giu, "[redacted]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[redacted]")
    .replace(
      /(["']?)(authorization|access[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password|credential)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;}\]]+|[^\s,;}\]]+)/giu,
      "$2=[redacted]",
    )
    .replace(
      /(?:~\/|\/(?:Users|home|tmp|var|private|etc|opt|srv|mnt|run|usr|Library|Applications|Volumes|dev|proc|sys)(?:\/|$))[^\r\n,;]*/gu,
      "[redacted]",
    );
  let sanitized = "";
  for (const character of redacted) {
    const code = character.charCodeAt(0);
    sanitized += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  return sanitized;
}

/** A browser event listener installed on the host-backed browser shell. */
export type BrowserShellEventListener = (event: BrowserEvent) => void;

/** Removes a browser shell event listener. */
export type BrowserShellSubscription = () => void;

/** The renderer-facing browser surface exposed by an Electron host. */
export interface BrowserShellPort {
  readonly kind: "desktop-browser";
  readonly call: (request: BrowserCall) => Promise<BrowserCallResult>;
  readonly subscribe: (listener: BrowserShellEventListener) => BrowserShellSubscription;
}

/** Feature-detects the browser shell without accepting a desktop shell or a partial port. */
export function isBrowserShellPort(value: unknown): value is BrowserShellPort {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<BrowserShellPort>;
  return candidate.kind === "desktop-browser"
    && typeof candidate.call === "function"
    && typeof candidate.subscribe === "function";
}

const MUTATING_BROWSER_METHODS: Record<string, true> = {
  new: true,
  "new-tab": true,
  new_tab: true,
  create: true,
  close: true,
  "close-tab": true,
  close_tab: true,
  switch: true,
  "switch-tab": true,
  switch_tab: true,
  navigate: true,
  open: true,
  open_split: true,
  reload: true,
  back: true,
  forward: true,
  click: true,
  dblclick: true,
  fill: true,
  type: true,
  hover: true,
  focus: true,
  focus_webview: true,
  check: true,
  uncheck: true,
  select: true,
  drag: true,
  upload: true,
  press: true,
  keydown: true,
  keyup: true,
  scroll: true,
  scrollintoview: true,
  scroll_into_view: true,
  eval: true,
  clear: true,
  set: true,
  route: true,
  unroute: true,
  viewport: true,
  device: true,
  geo: true,
  geolocation: true,
  offline: true,
  headers: true,
  credentials: true,
  auth: true,
  media: true,
  proxy: true,
  useragent: true,
  locale: true,
  timezone: true,
  permissions: true,
  respond: true,
  move: true,
  main: true,
  frame: true,
  start: true,
  stop: true,
  restart: true,
  highlight: true,
  save: true,
  load: true,
  tap: true,
  swipe: true,
  omnibox: true,
  goback: true,
  goforward: true,
  setbounds: true,
  setmuted: true,
  setomnibarvisible: true,
  focusaddressbar: true,
  restore: true,
  rename: true,
  delete: true,
  addinitscript: true,
  addscript: true,
  addstyle: true,
  import: true,
  toggle: true,
  input_mouse: true,
  input_keyboard: true,
  input_touch: true,
};

/** Returns true for every browser call that can change the active browser surface. */
export function browserMethodIsMutation(method: BrowserMethod): boolean {
  const normalizedMethod = method.toLowerCase();
  if (normalizedMethod.startsWith("browser.import.")) return true;
  const action = normalizedMethod.slice(normalizedMethod.lastIndexOf(".") + 1).replaceAll("-", "_");
  return MUTATING_BROWSER_METHODS[action] === true || action === "accept" || action === "dismiss";
}

/**
 * Resolves a profile for a browser call. Isolated sessions are safe to use implicitly;
 * authenticated profiles require the exact id selected by the user.
 */
export function requireExplicitBrowserProfile(
  profile: BrowserProfile,
  selectedProfileId: string | null,
): BrowserProfile {
  if (profile.kind === "isolated-session") return profile;
  if (profile.kind === "authenticated-profile" && profile.profileId === selectedProfileId) return profile;
  throw new Error("An authenticated browser profile requires explicit selection");
}

const BROWSER_ERROR_DISPLAY_BYTES = 1_024;

function boundedUtf8(value: string): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= BROWSER_ERROR_DISPLAY_BYTES) return value;
  return new TextDecoder().decode(encoded.slice(0, BROWSER_ERROR_DISPLAY_BYTES));
}

/** Produces safe, bounded text for displaying a failed browser call. */
export function browserErrorMessage(error: BrowserCallError): string {
  const code = String(error.code);
  const message = redactedBrowserMessage(error.message);
  return boundedUtf8(`${code}: ${message}`);
}
