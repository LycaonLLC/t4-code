// Read-aloud contract: only settled assistant responses are eligible (in
// observer views too — eligibility has no ownership input), one utterance at
// a time with new speech replacing old, stop and dispose end playback, calm
// failure copy lands on the message that asked, and a disposed controller
// never sends text to the shell again.
import { describe, expect, it } from "vite-plus/test";

import {
  createReadAloudController,
  READ_ALOUD_FAILED_NOTICE,
  READ_ALOUD_MAX_CHARS,
  READ_ALOUD_UNAVAILABLE_NOTICE,
  readAloudEligible,
  speakableText,
  speechAvailable,
  type SpeechPort,
  type SpeechResult,
} from "./read-aloud.ts";
import type { TranscriptRow } from "./rows.ts";

function messageRow(overrides: {
  readonly id?: string;
  readonly role?: "user" | "assistant";
  readonly text?: string;
  readonly live?: boolean;
}): TranscriptRow {
  return {
    id: overrides.id ?? "m1",
    kind: "message",
    role: overrides.role ?? "assistant",
    text: overrides.text ?? "All done. The build passes.",
    reasoning: "",
    images: [],
    imageIssue: null,
    live: overrides.live ?? false,
    startedAt: "2026-07-16T00:00:00.000Z",
  };
}

interface Deferred {
  readonly promise: Promise<SpeechResult>;
  resolve(result: SpeechResult): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: (result: SpeechResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SpeechResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake shell port recording every speak/stop and controlling settlement. */
function fakePort() {
  const speakCalls: { text: string }[] = [];
  const speakDeferreds: Deferred[] = [];
  let stopCalls = 0;
  const port: SpeechPort = {
    speakText: (request) => {
      speakCalls.push(request);
      const d = deferred();
      speakDeferreds.push(d);
      return d.promise;
    },
    stopSpeaking: () => {
      stopCalls += 1;
      return Promise.resolve({ accepted: true });
    },
  };
  return {
    port,
    speakCalls,
    speakDeferreds,
    stopCalls: () => stopCalls,
  };
}

/** Drain the microtask queue so settled speak promises reach the controller. */
async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

describe("readAloudEligible", () => {
  it("accepts only a settled assistant response with speakable text", () => {
    expect(readAloudEligible(messageRow({}))).toBe(true);
  });

  it("excludes streaming responses until the entry settles", () => {
    expect(readAloudEligible(messageRow({ live: true }))).toBe(false);
  });

  it("excludes user messages and non-message rows", () => {
    expect(readAloudEligible(messageRow({ role: "user" }))).toBe(false);
    const toolGroup: TranscriptRow = { id: "t1", kind: "tool-group", calls: [], running: false };
    expect(readAloudEligible(toolGroup)).toBe(false);
  });

  it("excludes responses with nothing speakable (code-only)", () => {
    expect(readAloudEligible(messageRow({ text: "```ts\nconst x = 1;\n```" }))).toBe(false);
    expect(readAloudEligible(messageRow({ text: "   " }))).toBe(false);
  });

  it("stays available in observer views: eligibility reads only the row, never ownership", () => {
    // The function has no session-control parameter by design; a settled
    // response is speakable no matter who owns the session.
    expect(readAloudEligible.length).toBe(1);
    expect(readAloudEligible(messageRow({ id: "observer-visible" }))).toBe(true);
  });
});

describe("speakableText", () => {
  it("omits fenced code and keeps surrounding prose", () => {
    const text = speakableText("Fixed it.\n\n```ts\nconst secret = 1;\n```\n\nTests pass.");
    expect(text).toBe("Fixed it. Tests pass.");
  });

  it("keeps link and image text, drops URLs and inline-code backticks", () => {
    expect(speakableText("See [the docs](https://example.com) and `pnpm test`.")).toBe(
      "See the docs and pnpm test.",
    );
    expect(speakableText("![build badge](https://img.example/x.svg) is green")).toBe(
      "build badge is green",
    );
    expect(speakableText("Visit https://example.com/deep/path now")).toBe("Visit now");
  });

  it("drops heading, quote, bullet, and emphasis markers", () => {
    expect(speakableText("## Result\n> quoted\n- first\n**bold** and *soft*")).toBe(
      "Result quoted first bold and soft",
    );
  });

  it("bounds long responses at a word boundary", () => {
    const text = speakableText(`${"word ".repeat(2000)}end`);
    expect(text.length).toBeLessThanOrEqual(READ_ALOUD_MAX_CHARS);
    expect(text.endsWith("word")).toBe(true);
  });
});

describe("speechAvailable", () => {
  it("requires both halves of the contract and hides otherwise", () => {
    expect(speechAvailable(null)).toBe(false);
    expect(speechAvailable({})).toBe(false);
    expect(speechAvailable({ speakText: () => Promise.resolve({ accepted: true }) })).toBe(false);
    expect(speechAvailable(fakePort().port)).toBe(true);
  });
});

describe("createReadAloudController", () => {
  it("speaks a completed response, marks it active, and returns to idle on natural completion", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "Hello **world**");
    expect(controller.getState()).toEqual({ speakingId: "m1", notice: null });
    expect(shell.speakCalls).toEqual([{ text: "Hello world" }]);
    // The shell promise resolves when the utterance finishes playing.
    shell.speakDeferreds[0]!.resolve({ accepted: true });
    await flush();
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    expect(shell.stopCalls()).toBe(0);
  });

  it("replaces old speech with new: one active utterance at a time", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "first response");
    controller.toggle("m2", "second response");
    expect(controller.getState().speakingId).toBe("m2");
    expect(shell.speakCalls.map((call) => call.text)).toEqual([
      "first response",
      "second response",
    ]);
    // The superseded utterance failing late must not disturb the new one.
    shell.speakDeferreds[0]!.reject(new Error("interrupted"));
    await flush();
    expect(controller.getState()).toEqual({ speakingId: "m2", notice: null });
  });

  it("a superseded utterance completing late never clears the new one", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "first response");
    controller.toggle("m2", "second response");
    // The replaced utterance "finishes" (interruption reported as accepted).
    shell.speakDeferreds[0]!.resolve({ accepted: true });
    await flush();
    expect(controller.getState()).toEqual({ speakingId: "m2", notice: null });
    // The current utterance finishing naturally does clear it.
    shell.speakDeferreds[1]!.resolve({ accepted: true });
    await flush();
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
  });

  it("toggling the active message stops it", () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "read me");
    controller.toggle("m1", "read me");
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    expect(shell.stopCalls()).toBe(1);
    expect(shell.speakCalls).toHaveLength(1);
  });

  it("stop ends playback and is safe when idle", () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.stop();
    expect(shell.stopCalls()).toBe(0);
    controller.toggle("m1", "read me");
    controller.stop();
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    expect(shell.stopCalls()).toBe(1);
  });

  it("surfaces a calm notice on the asking message when the shell declines", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "read me");
    shell.speakDeferreds[0]!.resolve({ accepted: false, error: "engine gone" });
    await flush();
    expect(controller.getState()).toEqual({
      speakingId: null,
      notice: { messageId: "m1", text: READ_ALOUD_FAILED_NOTICE },
    });
  });

  it("surfaces the same calm copy when the shell call throws", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "read me");
    shell.speakDeferreds[0]!.reject(new Error("ipc torn down"));
    await flush();
    expect(controller.getState().notice).toEqual({
      messageId: "m1",
      text: READ_ALOUD_FAILED_NOTICE,
    });
  });

  it("a late failure from a stopped utterance never resurfaces", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "read me");
    controller.stop();
    shell.speakDeferreds[0]!.resolve({ accepted: false });
    await flush();
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
  });

  it("a stopped utterance settling late (any way) leaves the controller idle", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    controller.toggle("m1", "read me");
    controller.stop();
    expect(shell.stopCalls()).toBe(1);
    // The interrupted utterance resolves after stop; state stays idle.
    shell.speakDeferreds[0]!.resolve({ accepted: true });
    await flush();
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    // And the next speak works normally after the stop resolution.
    controller.toggle("m2", "next response");
    expect(controller.getState()).toEqual({ speakingId: "m2", notice: null });
  });

  it("reports honest unavailability without a shell contract", () => {
    const controller = createReadAloudController(null);
    expect(controller.available).toBe(false);
    controller.toggle("m1", "read me");
    expect(controller.getState()).toEqual({
      speakingId: null,
      notice: { messageId: "m1", text: READ_ALOUD_UNAVAILABLE_NOTICE },
    });
  });

  it("dispose stops active speech and never sends text afterwards", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });
    controller.toggle("m1", "read me");
    expect(notified).toBe(1);
    controller.dispose();
    expect(shell.stopCalls()).toBe(1);
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    // No text is sent after disposal, and disposed state never mutates.
    controller.toggle("m2", "never spoken");
    controller.stop();
    shell.speakDeferreds[0]!.reject(new Error("late"));
    await flush();
    expect(shell.speakCalls).toHaveLength(1);
    expect(shell.stopCalls()).toBe(1);
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    expect(notified).toBe(1);
  });

  it("unmount-time dispose ignores a late natural completion", async () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });
    controller.toggle("m1", "read me");
    controller.dispose();
    shell.speakDeferreds[0]!.resolve({ accepted: true });
    await flush();
    expect(controller.getState()).toEqual({ speakingId: null, notice: null });
    expect(notified).toBe(1);
  });

  it("notifies subscribers on state changes and honors unsubscribe", () => {
    const shell = fakePort();
    const controller = createReadAloudController(shell.port);
    let notified = 0;
    const unsubscribe = controller.subscribe(() => {
      notified += 1;
    });
    controller.toggle("m1", "read me");
    expect(notified).toBe(1);
    unsubscribe();
    controller.stop();
    expect(notified).toBe(1);
  });
});
