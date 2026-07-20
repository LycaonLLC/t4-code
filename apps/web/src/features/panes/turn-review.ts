import {
  decodeArtifactDescriptor,
  type TranscriptArtifactReference,
} from "../transcript/artifact-metadata.ts";
import type { ReviewApplyState, ReviewFile, ReviewFileKind, ReviewFileStatus } from "./model.ts";

export const MAX_TURN_FILE_CHANGES = 4096;

export interface TurnReviewChange {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: ReviewFileStatus;
  readonly kind: ReviewFileKind;
  readonly additions: number;
  readonly deletions: number;
  readonly size: number | null;
  readonly state: ReviewApplyState;
}

export interface TurnReviewSnapshot {
  readonly turnId: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly changes: readonly TurnReviewChange[];
  readonly patch: TranscriptArtifactReference | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

/** Strict local adapter for the additive files.diff turn response. */
export function decodeTurnReviewSnapshot(value: unknown): TurnReviewSnapshot {
  if (
    !record(value) ||
    !Object.keys(value).every((key) =>
      ["turnId", "baseTree", "headTree", "changes", "patch", "artifacts"].includes(key),
    ) ||
    typeof value.turnId !== "string" ||
    value.turnId.length === 0 ||
    value.turnId.length > 512 ||
    typeof value.baseTree !== "string" ||
    value.baseTree.length > 128 ||
    typeof value.headTree !== "string" ||
    value.headTree.length > 128 ||
    !Array.isArray(value.changes) ||
    value.changes.length > MAX_TURN_FILE_CHANGES ||
    (value.artifacts !== undefined && !Array.isArray(value.artifacts))
  ) {
    throw new Error("Invalid turn review response.");
  }
  const changes: TurnReviewChange[] = value.changes.map((change) => {
    if (
      !record(change) ||
      !Object.keys(change).every((key) =>
        [
          "path",
          "previousPath",
          "status",
          "kind",
          "additions",
          "deletions",
          "size",
          "state",
        ].includes(key),
      ) ||
      !safePath(change.path) ||
      (change.previousPath !== undefined && !safePath(change.previousPath)) ||
      !["added", "modified", "deleted", "renamed", "copied", "untracked"].includes(
        String(change.status),
      ) ||
      !["text", "binary", "huge", "missing"].includes(String(change.kind)) ||
      !["pending", "applied", "discarded"].includes(String(change.state)) ||
      !nonNegative(change.additions) ||
      !nonNegative(change.deletions) ||
      (change.size !== undefined && !nonNegative(change.size))
    ) {
      throw new Error("Invalid turn review change.");
    }
    return {
      path: change.path,
      previousPath: change.previousPath ?? null,
      status: change.status as ReviewFileStatus,
      kind: change.kind as ReviewFileKind,
      additions: change.additions,
      deletions: change.deletions,
      size: change.size ?? null,
      state: change.state as ReviewApplyState,
    };
  });
  let patch: TranscriptArtifactReference | null = null;
  if (value.patch !== undefined) {
    const descriptor = decodeArtifactDescriptor(value.patch);
    if (descriptor.kind !== "patch") throw new Error("Invalid turn review patch.");
    patch = { ...descriptor, source: "artifact" };
  }
  return {
    turnId: value.turnId,
    baseTree: value.baseTree,
    headTree: value.headTree,
    changes,
    patch,
  };
}

function patchSections(patch: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  const starts = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    if (match === undefined) continue;
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? patch.length;
    const path = match[2];
    if (path !== undefined && safePath(path)) sections.set(path, patch.slice(start, end));
  }
  return sections;
}

/** Associates a complete unified diff section only when its header names that file. */
export function reviewFilesFromTurnSnapshot(
  snapshot: TurnReviewSnapshot,
  patch: string | null = null,
): readonly ReviewFile[] {
  const sections = patch === null ? new Map<string, string>() : patchSections(patch);
  return snapshot.changes.map((change) => ({
    path: change.path,
    oldPath: change.previousPath,
    status: change.status,
    kind: change.kind,
    additions: change.additions,
    deletions: change.deletions,
    patch: change.kind === "text" ? (sections.get(change.path) ?? null) : null,
    sizeBytes: change.size,
    applyState: change.state,
  }));
}

export interface TurnReviewApplyResult {
  readonly turnId: string;
  readonly path: string;
  readonly action: "keep" | "discard";
  readonly state: Exclude<ReviewApplyState, "pending">;
  readonly resultingRevision: string;
}

export function decodeTurnReviewApplyResult(
  value: unknown,
  expected: { readonly turnId: string; readonly path: string; readonly action: "keep" | "discard" },
): TurnReviewApplyResult {
  if (
    !record(value) ||
    Object.keys(value).length !== 5 ||
    value.turnId !== expected.turnId ||
    value.path !== expected.path ||
    value.action !== expected.action ||
    !["applied", "discarded"].includes(String(value.state)) ||
    typeof value.resultingRevision !== "string" ||
    value.resultingRevision.length === 0 ||
    value.resultingRevision.length > 128
  ) {
    throw new Error("Invalid turn review apply response.");
  }
  return {
    turnId: expected.turnId,
    path: expected.path,
    action: expected.action,
    state: value.state as Exclude<ReviewApplyState, "pending">,
    resultingRevision: value.resultingRevision,
  };
}
