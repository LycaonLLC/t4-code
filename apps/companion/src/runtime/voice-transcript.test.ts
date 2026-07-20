import { describe, expect, it } from "vite-plus/test";

import { reconcileVoiceTranscript } from "./voice-transcript";

describe("reconcileVoiceTranscript", () => {
  it("replaces interim recognition while preserving user text entered after it", () => {
    const interim = reconcileVoiceTranscript("fix", "the tests");
    expect(interim).toEqual({ value: "fix the tests", range: { start: 4, text: "the tests" } });

    expect(reconcileVoiceTranscript("fix the tests urgently", "all tests", interim?.range)).toEqual({
      value: "fix all tests urgently",
      range: { start: 4, text: "all tests" },
    });
  });

  it("refuses to overwrite a recognition span the user edited", () => {
    const interim = reconcileVoiceTranscript("fix", "the tests");
    expect(reconcileVoiceTranscript("fix those tests", "all tests", interim?.range)).toBeUndefined();
  });

  it("preserves existing trailing whitespace before the first result", () => {
    expect(reconcileVoiceTranscript("fix  ", "the tests")).toEqual({
      value: "fix  the tests",
      range: { start: 5, text: "the tests" },
    });
  });
});
