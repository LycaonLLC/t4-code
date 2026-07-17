// Per-message read-aloud controller. One utterance app-wide: speaking a new
// response replaces the old one, stopping is instant, and nothing ever plays
// without a tap on a specific completed message — observer sessions included,
// ambient/autoplay speech excluded by construction (only `toggle` speaks).
//
// Speech goes through the optional shell contract only (`speakText` /
// `stopSpeaking`); this module never touches an audio API itself and never
// sends text after `dispose`. Failures surface as one calm sentence on the
// message that asked, in the transcript's existing quiet-status vocabulary.
import type { TranscriptRow } from "./rows.ts";

/**
 * Structural mirror of the optional shell speech contract. Any shell port
 * (desktop preload or browser) that carries the optional methods is
 * assignable; a port without them simply reports speech unavailable.
 */
export interface SpeechResult {
  readonly accepted: boolean;
  readonly error?: string;
}

export interface SpeechPort {
  readonly speakText?: (request: { readonly text: string }) => Promise<SpeechResult>;
  readonly stopSpeaking?: () => Promise<SpeechResult>;
}

/** Both halves must exist: speech we cannot stop is speech we never start. */
export function speechAvailable(port: SpeechPort | null): boolean {
  return (
    port !== null &&
    typeof port.speakText === "function" &&
    typeof port.stopSpeaking === "function"
  );
}

// ---------------------------------------------------------------------------
// Copy — the full read-aloud vocabulary, quiet and engine-free.
// ---------------------------------------------------------------------------

export const READ_ALOUD_LABEL = "Read response aloud";
export const STOP_READING_LABEL = "Stop reading";
export const READ_ALOUD_FAILED_NOTICE = "Read aloud didn't start. Try again.";
export const READ_ALOUD_UNAVAILABLE_NOTICE = "Read aloud isn't available on this device.";

// ---------------------------------------------------------------------------
// Eligibility and speakable text
// ---------------------------------------------------------------------------

/** Spoken text stays bounded no matter how long the response ran. */
export const READ_ALOUD_MAX_CHARS = 4000;

/**
 * Only a settled assistant response with something speakable qualifies.
 * Deliberately independent of session ownership: observers may listen to any
 * completed response; streaming rows are excluded until the entry settles.
 */
export function readAloudEligible(row: TranscriptRow): boolean {
  return (
    row.kind === "message" &&
    row.role === "assistant" &&
    !row.live &&
    speakableText(row.text) !== ""
  );
}

/**
 * Conservative markdown-to-speech reduction: drop fenced code and horizontal
 * rules, keep link and image text without URLs, unwrap inline code and
 * emphasis, drop heading/quote/bullet markers, then bound the result at a
 * word boundary. Anything not confidently noise is kept verbatim.
 */
export function speakableText(markdown: string): string {
  const text = markdown
    // Fenced code blocks are technical noise; omit them entirely.
    .replace(/^ {0,3}(```|~~~).*$[\s\S]*?(^ {0,3}\1`* *$|(?![\s\S]))/gm, " ")
    // Images and links: keep the human text, drop the URL.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Bare URLs read as character soup.
    .replace(/https?:\/\/\S+/g, "")
    // Inline code keeps its content, loses the backticks.
    .replace(/`([^`\n]+)`/g, "$1")
    // Structural markers at line starts: headings, quotes, bullets, rules.
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^ {0,3}[-*+]\s+/gm, "")
    .replace(/^ {0,3}([-*_])( *\1){2,} *$/gm, "")
    // Bold/italic wrappers.
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= READ_ALOUD_MAX_CHARS) return text;
  const cut = text.lastIndexOf(" ", READ_ALOUD_MAX_CHARS);
  return text.slice(0, cut > 0 ? cut : READ_ALOUD_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ReadAloudNotice {
  /** The message the notice belongs to; rendered inline beside its actions. */
  readonly messageId: string;
  readonly text: string;
}

export interface ReadAloudState {
  /** Message currently being read aloud; null when idle. */
  readonly speakingId: string | null;
  readonly notice: ReadAloudNotice | null;
}

export interface ReadAloudController {
  readonly available: boolean;
  getState(): ReadAloudState;
  subscribe(listener: () => void): () => void;
  /** Speak this message, replacing any current speech; stop if it is already speaking. */
  toggle(messageId: string, text: string): void;
  /** Stop whatever is playing; safe when idle. */
  stop(): void;
  /** Terminal: stops speech and guarantees no text is sent afterwards. */
  dispose(): void;
}

const IDLE_STATE: ReadAloudState = { speakingId: null, notice: null };

export function createReadAloudController(port: SpeechPort | null): ReadAloudController {
  const available = speechAvailable(port);
  const listeners = new Set<() => void>();
  let state = IDLE_STATE;
  let disposed = false;
  // Every user action bumps the generation; a settled speak result only
  // applies if no newer action has superseded it.
  let generation = 0;

  function setState(next: ReadAloudState): void {
    if (next.speakingId === state.speakingId && next.notice === state.notice) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function stopShell(): void {
    if (available) void port!.stopSpeaking!().catch(() => undefined);
  }

  function speak(messageId: string, text: string): void {
    if (!available) {
      setState({ speakingId: null, notice: { messageId, text: READ_ALOUD_UNAVAILABLE_NOTICE } });
      return;
    }
    const spoken = speakableText(text);
    if (spoken === "") return;
    const turn = ++generation;
    setState({ speakingId: messageId, notice: null });
    // The shell promise settles when the utterance finishes (or fails):
    // accepted completion returns the action to idle; a declined or thrown
    // speak surfaces the calm notice. Either way, a superseded or disposed
    // turn is ignored so late settlements never clobber newer speech.
    port!.speakText!({ text: spoken }).then(
      (result) => {
        if (disposed || turn !== generation) return;
        setState(
          result.accepted
            ? IDLE_STATE
            : { speakingId: null, notice: { messageId, text: READ_ALOUD_FAILED_NOTICE } },
        );
      },
      () => {
        if (disposed || turn !== generation) return;
        setState({ speakingId: null, notice: { messageId, text: READ_ALOUD_FAILED_NOTICE } });
      },
    );
  }

  function stop(): void {
    if (disposed) return;
    generation += 1;
    const wasSpeaking = state.speakingId !== null;
    setState(IDLE_STATE);
    if (wasSpeaking) stopShell();
  }

  return {
    available,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle(messageId, text) {
      if (disposed) return;
      if (state.speakingId === messageId) {
        stop();
        return;
      }
      speak(messageId, text);
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const wasSpeaking = state.speakingId !== null;
      state = IDLE_STATE;
      listeners.clear();
      if (wasSpeaking) stopShell();
    },
  };
}
