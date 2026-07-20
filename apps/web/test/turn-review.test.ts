import { describe, expect, it } from "vite-plus/test";

import {
  decodeTurnReviewApplyResult,
  decodeTurnReviewSnapshot,
  MAX_TURN_FILE_CHANGES,
  reviewFilesFromTurnSnapshot,
} from "../src/features/panes/turn-review.ts";

const patchDescriptor = {
  artifactId: "2001",
  kind: "patch",
  mediaType: "text/x-diff",
  size: 128,
  sha256: "a".repeat(64),
  name: "2001.turn-review.log",
  disposition: "attachment",
  retention: "session",
};

describe("turn review adapter", () => {
  it("strictly decodes the canonical 0.7 snapshot and associates loaded patch sections", () => {
    const snapshot = decodeTurnReviewSnapshot({
      turnId: "turn-1",
      baseTree: "base",
      headTree: "head",
      changes: [
        {
          path: "src/new.ts",
          status: "renamed",
          previousPath: "src/old.ts",
          kind: "text",
          state: "pending",
          additions: 2,
          deletions: 1,
        },
      ],
      patch: patchDescriptor,
    });
    const patch =
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n@@ -1 +1 @@\n-old\n+new\n";
    expect(snapshot).toMatchObject({
      turnId: "turn-1",
      patch: { artifactId: "2001", source: "artifact" },
    });
    expect(reviewFilesFromTurnSnapshot(snapshot, patch)).toMatchObject([
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        patch: expect.stringContaining("rename from"),
      },
    ]);
  });

  it("keeps binary, huge, copied, and untracked files patchless rather than guessing", () => {
    const snapshot = decodeTurnReviewSnapshot({
      turnId: "turn-2",
      baseTree: "base",
      headTree: "head",
      changes: [
        {
          path: "assets/a.bin",
          status: "copied",
          previousPath: "assets/original.bin",
          kind: "binary",
          state: "pending",
          additions: 0,
          deletions: 0,
        },
        {
          path: "src/generated.ts",
          status: "untracked",
          kind: "huge",
          state: "pending",
          additions: 5000,
          deletions: 0,
        },
      ],
    });
    const patch =
      "diff --git a/assets/a.bin b/assets/a.bin\nBinary files a/assets/a.bin and b/assets/a.bin differ\n";
    expect(reviewFilesFromTurnSnapshot(snapshot, patch).map((file) => file.patch)).toEqual([
      null,
      null,
    ]);
  });

  it("rejects unsafe paths, oversize turn lists, and mismatched action outcomes", () => {
    expect(() =>
      decodeTurnReviewSnapshot({
        turnId: "turn-3",
        baseTree: "a",
        headTree: "b",
        changes: [
          {
            path: "../no",
            status: "added",
            kind: "text",
            state: "pending",
            additions: 1,
            deletions: 0,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeTurnReviewSnapshot({
        turnId: "turn-4",
        baseTree: "a",
        headTree: "b",
        changes: Array.from({ length: MAX_TURN_FILE_CHANGES + 1 }, () => ({
          path: "a",
          status: "added",
          kind: "text",
          state: "pending",
          additions: 0,
          deletions: 0,
        })),
      }),
    ).toThrow();
    const expected = { turnId: "turn-5", path: "src/a.ts", action: "discard" } as const;
    expect(() =>
      decodeTurnReviewApplyResult(
        {
          ...expected,
          state: "pending",
          resultingRevision: "revision-2",
        },
        expected,
      ),
    ).toThrow();
    expect(
      decodeTurnReviewApplyResult(
        {
          ...expected,
          state: "discarded",
          resultingRevision: "revision-2",
        },
        expected,
      ),
    ).toMatchObject({ path: "src/a.ts", state: "discarded" });
  });
});
