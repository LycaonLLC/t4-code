// Live inspector wiring: one inspector store per active desktop session,
// fed exclusively by the runtime's session projection and answering pane
// actions with typed commands through the runtime controller. Nothing here
// reads fixtures, scrapes output, or fabricates state — what the frames do
// not say, the panes do not show.
import type {
  DesktopRuntimeController,
  DesktopRuntimeSnapshot,
  SessionProjection,
} from "@t4-code/client";
import {
  hostId as brandHostId,
  requiredCapability,
  revision as brandRevision,
  sessionId as brandSessionId,
  type Revision,
} from "@t4-code/protocol";
import type { CommandResult } from "@t4-code/protocol/desktop-ipc";

import { resolveLiveSession } from "../../platform/live-workspace.ts";
import { presentSessionControl, readSessionControl } from "../session-runtime/session-observer.ts";
import { sessionWriteLink } from "../session-runtime/session-inventory.ts";
import {
  transcriptImageSourceForSession,
  type TranscriptImageSource,
} from "../session-runtime/transcript-images.ts";
import type { TranscriptArtifactReference } from "../transcript/artifact-metadata.ts";
import { cancelConfirmedAgent, type AgentCancelRuntime } from "../session-runtime/agent-cancel.ts";
import {
  beginTurnReviewAction,
  createInspectorStore,
  installInspectorStoreFactory,
  resolveDir,
  resolvePreview,
  resolveFileWriteOutcome,
  rejectTurnReviewAction,
  resolveReviewOutcome,
  resolveTurnReview,
  resolveTurnReviewOutcome,
  type InspectorController,
  type InspectorStoreApi,
} from "./inspector-store.ts";
import {
  agentNodeFromFrame,
  collectActivity,
  fileListingsFromFrames,
  isSafeRelativePath,
  previewFromFileFrame,
  reviewProjectionFromFrames,
  sameAgentNode,
  sameListing,
  sameReviewFiles,
} from "./live-projection.ts";
import {
  decodeTurnReviewApplyResult,
  decodeTurnReviewSnapshot,
  reviewFilesFromTurnSnapshot,
} from "./turn-review.ts";
import type {
  AgentNode,
  FileTreeNode,
  InspectorActionAvailability,
  PaneActionAvailability,
  ReviewFile,
} from "./model.ts";

/**
 * The slice of DesktopRuntimeController this module needs. Structural, so
 * tests can drive the seam with recorded snapshots and a scripted command
 * port instead of a full Electron shell.
 */
export interface LiveInspectorRuntime extends AgentCancelRuntime {
  getSnapshot(): DesktopRuntimeSnapshot;
  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void;
}

async function readTurnPatch(
  source: TranscriptImageSource,
  reference: TranscriptArtifactReference,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let release: () => void = () => undefined;
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(() => finish(new Error("Turn patch read timed out.")), 30_000);
    const finish = (outcome: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (outcome instanceof Error) {
        release();
        reject(outcome);
        return;
      }
      void fetch(outcome)
        .then((response) => response.text())
        .then(resolve, reject)
        .finally(release);
    };
    const inspect = () => {
      const snapshot = source.getSnapshot(reference);
      if (snapshot.status === "ready") finish(snapshot.url);
      else if (snapshot.status === "error" || snapshot.status === "unavailable") {
        finish(new Error(snapshot.reason));
      }
    };
    unsubscribe = source.subscribe(reference, inspect);
    release = source.retain(reference);
    inspect();
  });
}

const ENABLED: PaneActionAvailability = Object.freeze({ enabled: true, reason: null });
const SYNCING_WRITE: PaneActionAvailability = Object.freeze({
  enabled: false,
  reason: "This session is still syncing from the host. Try again in a moment.",
});

// Actions the wire has no command for. Disabled with the honest reason —
// never a silent no-op that pretends the host heard something.
const NO_STEER: PaneActionAvailability = Object.freeze({
  enabled: false,
  reason: "This host cannot take a note for a single agent.",
});
const NO_WAKE: PaneActionAvailability = Object.freeze({
  enabled: false,
  reason: "This host cannot wake an agent from here.",
});
const NO_DISCARD: PaneActionAvailability = Object.freeze({
  enabled: false,
  reason: "This host cannot discard a change from here.",
});

/** Protocol features a command additionally depends on, beyond capability. */
const FEATURE_BY_COMMAND: Readonly<Record<string, string>> = {
  "files.list": "files.list",
  "files.diff": "files.diff",
};

/**
 * Is one wire command usable against this host right now? Connection,
 * granted capability, negotiated feature, and the host's own catalog all
 * get a veto; the first missing piece names itself.
 */
export function commandAvailability(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostId: string,
  command: string,
): PaneActionAvailability {
  if (snapshot.connections.get(targetId) !== "connected") {
    return { enabled: false, reason: "This host is offline right now." };
  }
  const host = snapshot.hosts.get(hostId);
  if (host === undefined) {
    return { enabled: false, reason: "Waiting for this host to answer." };
  }
  const capability = requiredCapability(command);
  if (capability === undefined || !host.grantedCapabilities.includes(capability)) {
    return { enabled: false, reason: "This host has not allowed this action for this device." };
  }
  const feature = FEATURE_BY_COMMAND[command];
  if (feature !== undefined && !host.grantedFeatures.includes(feature)) {
    return { enabled: false, reason: "This host's runtime does not support this action." };
  }
  const catalog = snapshot.catalogs.get(hostId);
  if (catalog !== undefined) {
    const item = catalog.items.find(
      (candidate) =>
        candidate.kind === "command" &&
        (String(candidate.id) === command || candidate.name === command),
    );
    if (item !== undefined && item.supported === false) {
      return { enabled: false, reason: item.reason ?? "This host has turned this action off." };
    }
  }
  return ENABLED;
}

/** Per-action availability for one session, from the current runtime truth. */
export function deriveActionAvailability(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostId: string,
  sessionId: string,
  revisionKnown: boolean,
): InspectorActionAvailability {
  const agentCancel = commandAvailability(snapshot, targetId, hostId, "agent.cancel");
  const apply = commandAvailability(snapshot, targetId, hostId, "review.apply");
  const reviewApply =
    apply.enabled && !revisionKnown
      ? { enabled: false, reason: "Waiting for this session's latest state." }
      : apply;
  const write = commandAvailability(snapshot, targetId, hostId, "files.write");
  const fileWrite =
    write.enabled && !revisionKnown
      ? { enabled: false, reason: "Waiting for this session's latest state." }
      : write;
  const writeGate =
    sessionWriteLink(snapshot, targetId, hostId, sessionId) === "live" ? null : SYNCING_WRITE;
  return {
    agentSteer: NO_STEER,
    agentCancel: writeGate !== null && agentCancel.enabled ? writeGate : agentCancel,
    agentWake: NO_WAKE,
    reviewApply: writeGate !== null && reviewApply.enabled ? writeGate : reviewApply,
    reviewDiscard: NO_DISCARD,
    fileWrite: writeGate !== null && fileWrite.enabled ? writeGate : fileWrite,
  };
}

function sameAvailability(a: InspectorActionAvailability, b: InspectorActionAvailability): boolean {
  const pairs: ReadonlyArray<readonly [PaneActionAvailability, PaneActionAvailability]> = [
    [a.agentSteer, b.agentSteer],
    [a.agentCancel, b.agentCancel],
    [a.agentWake, b.agentWake],
    [a.reviewApply, b.reviewApply],
    [a.reviewDiscard, b.reviewDiscard],
    [a.fileWrite, b.fileWrite],
  ];
  return pairs.every(
    ([left, right]) => left.enabled === right.enabled && left.reason === right.reason,
  );
}

interface LiveSessionAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

/** Resolve the view id ("host/session") like the session runtime does. */
function addressForViewId(snapshot: DesktopRuntimeSnapshot, viewId: string): LiveSessionAddress {
  const resolved = resolveLiveSession(snapshot, viewId);
  if (resolved !== null) return resolved;
  const separator = viewId.indexOf("/");
  return {
    targetId: "local",
    hostId: decodeURIComponent(separator > 0 ? viewId.slice(0, separator) : viewId),
    sessionId: decodeURIComponent(separator > 0 ? viewId.slice(separator + 1) : ""),
  };
}

function fileTreeNodesFromListResult(result: unknown): readonly FileTreeNode[] | "error" {
  if (result === null || typeof result !== "object") return "error";
  const entries = (result as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return "error";
  const nodes: FileTreeNode[] = [];
  for (const item of entries) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    if (!isSafeRelativePath(path)) continue;
    const kind = record.kind === "dir" || record.kind === "directory" ? "dir" : "file";
    const slash = path.lastIndexOf("/");
    nodes.push({ path, name: slash === -1 ? path : path.slice(slash + 1), kind });
  }
  return nodes;
}

/**
 * One live inspector store for one desktop session. The store starts empty
 * (no sample data ever), fills from the warm projection, and stays
 * subscribed for the window's lifetime — reconnects and cached snapshots
 * update freshness without clearing what was already safely projected.
 */
export function createLiveInspectorStore(
  runtime: LiveInspectorRuntime,
  viewId: string,
): InspectorStoreApi {
  const address = addressForViewId(runtime.getSnapshot(), viewId);
  const projectionKey = `${address.hostId}\u0000${address.sessionId}`;
  const wireHostId = brandHostId(address.hostId);
  const wireSessionId = brandSessionId(address.sessionId);

  const agentCache = new Map<string, AgentNode>();
  const seenActivity = new Set<string>();
  /** Directory paths resolved from a real `files.list` answer. */
  const listedDirs = new Set<string>();
  /** Directory paths resolved from pushed file frames; refreshed on sync. */
  const frameDirs = new Set<string>();
  const pendingDirs = new Map<string, string>();
  const pendingPreviews = new Map<
    string,
    { readonly path: string; readonly baseRevision: string | null }
  >();
  const pendingReviewApplies = new Map<string, string>();
  let reviewFiles: readonly ReviewFile[] = [];
  let reviewIdByPath: ReadonlyMap<string, string> = new Map();
  let availability: InspectorActionAvailability | null = null;

  const warmSession = (snapshot: DesktopRuntimeSnapshot): SessionProjection | undefined =>
    snapshot.projection.sessions.get(projectionKey);

  const expectedRevision = (): Revision | undefined => {
    const snapshot = runtime.getSnapshot();
    const warmRevision = warmSession(snapshot)?.revision;
    if (warmRevision !== undefined) return brandRevision(warmRevision);
    return snapshot.projection.sessionIndex.get(projectionKey)?.revision;
  };

  /**
   * Current strict ownership truth; rechecked immediately before every pane
   * write dispatch (`commandAvailability` already vetoes a dead connection).
   * Non-null means another app owns the session, this one is still taking
   * it over, or the shape is unproven — never dispatch.
   */
  const sessionControlNow = (snapshot: DesktopRuntimeSnapshot) =>
    readSessionControl(
      warmSession(snapshot)?.ref ?? snapshot.projection.sessionIndex.get(projectionKey),
    );

  /** Dispatch-time freshness + ownership recheck for pane writes. */
  const writableNow = (snapshot: DesktopRuntimeSnapshot): boolean =>
    sessionWriteLink(snapshot, address.targetId, address.hostId, address.sessionId) === "live" &&
    sessionControlNow(snapshot) === null;

  const assertAgentCancelWritable = (): void => {
    const snapshot = runtime.getSnapshot();
    const support = commandAvailability(snapshot, address.targetId, address.hostId, "agent.cancel");
    if (!support.enabled) throw new Error(support.reason ?? "Agent cancellation is unavailable.");
    if (writableNow(snapshot)) return;
    const control = sessionControlNow(snapshot);
    if (control !== null) throw new Error(presentSessionControl(control).controlReason);
    throw new Error(SYNCING_WRITE.reason ?? "This session is still syncing from the host.");
  };

  const sendCommand = (
    command: string,
    args: Record<string, unknown>,
    withRevision: boolean,
  ): Promise<CommandResult> => {
    const revisionValue = withRevision ? expectedRevision() : undefined;
    return runtime.command(address.targetId, {
      hostId: wireHostId,
      sessionId: wireSessionId,
      command,
      args,
      ...(revisionValue === undefined ? {} : { expectedRevision: revisionValue }),
    });
  };

  const controller = (api: InspectorStoreApi): InspectorController => ({
    kind: "desktop",
    performControl(scope) {
      if (scope.action !== "cancel") return;
      void cancelConfirmedAgent(runtime, {
        address,
        agentId: scope.agentId,
        assertWritable: assertAgentCancelWritable,
        currentRevision() {
          const current = expectedRevision();
          if (current === undefined) throw new Error("Waiting for this session's latest state.");
          return String(current);
        },
      }).catch(() => {
        // Outcome unknown: never resent. The next agent frame carries truth.
      });
    },
    performReview(action, path) {
      const review = api.getState().review;
      const snapshot = runtime.getSnapshot();
      if (
        !commandAvailability(snapshot, address.targetId, address.hostId, "review.apply").enabled ||
        !writableNow(snapshot)
      ) {
        return;
      }
      if (review.source === "turn" && typeof review.turnId === "string") {
        const request = { turnId: review.turnId, path, action } as const;
        const reviewRevision = beginTurnReviewAction(api, request);
        if (reviewRevision === null) return;
        const protocolAction = action === "apply" ? "keep" : "discard";
        void runtime
          .command(address.targetId, {
            hostId: wireHostId,
            sessionId: wireSessionId,
            command: "review.apply",
            args: { turnId: request.turnId, path, action: protocolAction },
            expectedRevision: brandRevision(reviewRevision),
          })
          .then((result) => {
            if (!result.accepted) {
              rejectTurnReviewAction(api, request, "The host did not confirm this review action.");
              return;
            }
            const outcome = decodeTurnReviewApplyResult(result.result, {
              turnId: request.turnId,
              path,
              action: protocolAction,
            });
            resolveTurnReviewOutcome(api, request, {
              applyState: outcome.state,
              resultingRevision: outcome.resultingRevision,
            });
          })
          .catch(() => {
            rejectTurnReviewAction(
              api,
              request,
              "The connection dropped before the host confirmed this review action.",
            );
          });
        return;
      }
      if (action !== "apply") return;
      const revisionValue = expectedRevision();
      if (revisionValue === undefined) return;
      const reviewId = reviewIdByPath.get(path);
      if (reviewId === undefined) return;
      void runtime
        .command(address.targetId, {
          hostId: wireHostId,
          sessionId: wireSessionId,
          command: "review.apply",
          args: { reviewId },
          expectedRevision: revisionValue,
        })
        .then((result) => {
          if (result.accepted) pendingReviewApplies.set(result.requestId, path);
        })
        .catch(() => {
          // Outcome unknown: the row stays pending and is never resent.
        });
    },
    loadTurnReview(turnId) {
      const snapshot = runtime.getSnapshot();
      const readable = commandAvailability(
        snapshot,
        address.targetId,
        address.hostId,
        "files.diff",
      );
      if (!readable.enabled) {
        resolveTurnReview(api, turnId, {
          error: readable.reason ?? "This host cannot load turn reviews.",
        });
        return;
      }
      void sendCommand("files.diff", { turnId }, false)
        .then(async (result) => {
          if (!result.accepted) {
            resolveTurnReview(api, turnId, { error: "The host could not load this turn review." });
            return;
          }
          const review = decodeTurnReviewSnapshot(result.result);
          if (review.turnId !== turnId) throw new Error("Turn review identity mismatch.");
          resolveTurnReview(api, turnId, {
            files: reviewFilesFromTurnSnapshot(review),
            revision: review.headTree,
          });
          if (review.patch === null) return;
          const source = transcriptImageSourceForSession(address.hostId, address.sessionId);
          if (source === null) return;
          const patch = await readTurnPatch(source, review.patch);
          resolveTurnReview(api, turnId, {
            files: reviewFilesFromTurnSnapshot(review, patch),
            revision: review.headTree,
          });
        })
        .catch(() =>
          resolveTurnReview(api, turnId, {
            error: "The connection dropped before the host answered.",
          }),
        );
    },
    loadDir(path) {
      const snapshot = runtime.getSnapshot();
      const listable = commandAvailability(
        snapshot,
        address.targetId,
        address.hostId,
        "files.list",
      );
      if (listable.enabled) {
        void sendCommand("files.list", path === "" ? {} : { path }, false)
          .then((result) => {
            if (result.accepted) pendingDirs.set(result.requestId, path);
            else resolveDir(api, path, "error");
          })
          .catch(() => resolveDir(api, path, "error"));
        return;
      }
      // No listing command: the pushed file frames are the whole tree.
      const listing = fileListingsFromFrames(warmSession(snapshot) ?? emptyProjection())[path];
      if (listing !== undefined && listing.length > 0) {
        frameDirs.add(path);
        resolveDir(api, path, listing);
      } else {
        resolveDir(api, path, "error");
      }
    },
    loadPreview(path) {
      const snapshot = runtime.getSnapshot();
      const warm = warmSession(snapshot);
      const frame = warm?.files.get(path);
      if (frame !== undefined && frame.content !== undefined) {
        resolvePreview(api, previewFromFileFrame(frame), warm?.revision ?? null);
        return;
      }
      if (snapshot.connections.get(address.targetId) !== "connected") {
        resolvePreview(api, { kind: "offline", path });
        return;
      }
      const readable = commandAvailability(
        snapshot,
        address.targetId,
        address.hostId,
        "files.read",
      );
      if (readable.enabled) {
        const readRevision = expectedRevision();
        void sendCommand("files.read", { path }, false)
          .then((result) => {
            if (result.accepted) {
              pendingPreviews.set(result.requestId, {
                path,
                baseRevision: readRevision === undefined ? null : String(readRevision),
              });
            } else {
              resolvePreview(api, {
                kind: "diagnostic",
                path,
                message: "The host could not read this file.",
              });
            }
          })
          .catch(() =>
            resolvePreview(api, {
              kind: "diagnostic",
              path,
              message: "The connection dropped before the host answered.",
            }),
          );
        return;
      }
      resolvePreview(
        api,
        frame !== undefined
          ? previewFromFileFrame(frame)
          : { kind: "diagnostic", path, message: "This host cannot read files from here." },
        warm?.revision ?? null,
      );
    },
    writeFile(path, content, baseRevision) {
      const snapshot = runtime.getSnapshot();
      const writable = commandAvailability(
        snapshot,
        address.targetId,
        address.hostId,
        "files.write",
      );
      const revisionValue = baseRevision === null ? undefined : brandRevision(baseRevision);
      if (
        !isSafeRelativePath(path) ||
        !writable.enabled ||
        !writableNow(snapshot) ||
        revisionValue === undefined
      ) {
        resolveFileWriteOutcome(api, path, "conflict");
        return;
      }
      void runtime
        .command(address.targetId, {
          hostId: wireHostId,
          sessionId: wireSessionId,
          command: "files.write",
          args: { path, content },
          expectedRevision: revisionValue,
        })
        .then((result) =>
          resolveFileWriteOutcome(
            api,
            path,
            result.accepted
              ? "saved"
              : result.error?.code === "stale_revision"
                ? "conflict"
                : "error",
          ),
        )
        .catch(() => resolveFileWriteOutcome(api, path, "error"));
    },
  });

  const store = createInspectorStore({ sampleMode: false, controller });

  const sync = (snapshot: DesktopRuntimeSnapshot): void => {
    const warm = warmSession(snapshot);
    let nextAvailability = deriveActionAvailability(
      snapshot,
      address.targetId,
      address.hostId,
      address.sessionId,
      expectedRevision() !== undefined,
    );
    // While another app owns this session (or this one is taking it over),
    // pane writes gate with the same honest reason the composer shows.
    // Already-disabled actions keep their more specific reason.
    const control = sessionControlNow(snapshot);
    if (control !== null) {
      const gate: PaneActionAvailability = {
        enabled: false,
        reason: presentSessionControl(control).controlReason,
      };
      nextAvailability = {
        ...nextAvailability,
        agentCancel: nextAvailability.agentCancel.enabled ? gate : nextAvailability.agentCancel,
        reviewApply: nextAvailability.reviewApply.enabled ? gate : nextAvailability.reviewApply,
        fileWrite: nextAvailability.fileWrite.enabled ? gate : nextAvailability.fileWrite,
      };
    }
    if (availability === null || !sameAvailability(availability, nextAvailability)) {
      availability = nextAvailability;
      store.getState().setActionAvailability(nextAvailability);
    }
    const offline = snapshot.connections.get(address.targetId) !== "connected";
    if (store.getState().files.offline !== offline) {
      store.setState((state) => ({ files: { ...state.files, offline } }));
    }
    if (warm === undefined) return;

    for (const frame of warm.agents.values()) {
      const node = agentNodeFromFrame(
        frame,
        warm.events,
        warm.agentTranscripts.get(String(frame.agentId)),
      );
      const previous = agentCache.get(node.id);
      if (previous !== undefined && sameAgentNode(previous, node)) continue;
      agentCache.set(node.id, node);
      store.getState().ingestAgent(node);
    }

    for (const { key, entry } of collectActivity(warm)) {
      if (seenActivity.has(key)) continue;
      seenActivity.add(key);
      store.getState().ingestActivity(entry);
    }

    const review = reviewProjectionFromFrames(warm);
    reviewIdByPath = review.reviewIdByPath;
    if (!sameReviewFiles(reviewFiles, review.files)) {
      reviewFiles = review.files;
      store.setState((state) =>
        state.review.source === "turn"
          ? state
          : {
              review: {
                ...state.review,
                files: review.files,
                source: "legacy",
                turnId: null,
                loading: false,
                error: null,
              },
            },
      );
    }

    // Settle command answers that arrived as response frames.
    for (const [requestId, path] of pendingDirs) {
      const result = warm.results.get(requestId);
      if (result === undefined) continue;
      pendingDirs.delete(requestId);
      if (result.ok) {
        const listing = fileTreeNodesFromListResult(result.result);
        resolveDir(store, path, listing);
        if (listing !== "error") listedDirs.add(path);
      } else {
        resolveDir(store, path, "error");
      }
    }
    for (const [requestId, pending] of pendingPreviews) {
      const result = warm.results.get(requestId);
      if (result === undefined) continue;
      pendingPreviews.delete(requestId);
      const content =
        result.ok && result.result !== null && typeof result.result === "object"
          ? (result.result as Record<string, unknown>).content
          : undefined;
      resolvePreview(
        store,
        typeof content === "string"
          ? { kind: "code", path: pending.path, text: content, truncated: content.length >= 8192 }
          : {
              kind: "diagnostic",
              path: pending.path,
              message: "The host could not read this file.",
            },
        pending.baseRevision,
      );
    }
    for (const [requestId, path] of pendingReviewApplies) {
      const result = warm.results.get(requestId);
      if (result === undefined) continue;
      pendingReviewApplies.delete(requestId);
      // A failed or denied apply leaves the row pending; only ok applies.
      if (result.ok) resolveReviewOutcome(store, path, "applied");
    }

    // Refresh frame-derived directory listings as new file frames arrive.
    if (frameDirs.size > 0) {
      const listings = fileListingsFromFrames(warm);
      for (const dir of frameDirs) {
        if (listedDirs.has(dir)) {
          frameDirs.delete(dir);
          continue;
        }
        const next = listings[dir];
        const current = store.getState().files.childrenByPath[dir];
        if (next !== undefined && Array.isArray(current) && !sameListing(current, next)) {
          resolveDir(store, dir, next);
        }
      }
    }

    // A pushed frame can answer a preview the command path could not.
    const { selectedPath, preview, previewRevision } = store.getState().files;
    const hasNewPreviewRevision =
      previewRevision === null ||
      (warm.revision !== undefined && String(warm.revision) !== previewRevision);
    if (selectedPath !== null && preview === "loading" && hasNewPreviewRevision) {
      const frame = warm.files.get(selectedPath);
      if (frame !== undefined && frame.content !== undefined) {
        resolvePreview(store, previewFromFileFrame(frame), warm.revision ?? null);
      }
    }
  };

  sync(runtime.getSnapshot());
  runtime.subscribe(sync);
  return store;
}

function emptyProjection(): SessionProjection {
  return {
    hostId: "",
    sessionId: "",
    entries: [],
    events: [],
    agents: new Map(),
    agentTranscripts: new Map(),
    terminals: new Map(),
    files: new Map(),
    reviews: new Map(),
    audit: [],
    confirmations: new Map(),
    results: new Map(),
    previews: new Map(),
    previewEvents: [],
    freshness: "cached",
    transcriptEventArrivalOrdinal: 0,
    contextMaintenanceEventArrivalOrdinal: 0,
    entryIds: new Set(),
  };
}

/**
 * Install the live inspector factory for the desktop shell. Browser mode
 * never calls this; its fixture factory stays exactly as before.
 */
export function installLiveInspector(runtime: DesktopRuntimeController): void {
  installInspectorStoreFactory((viewId) => createLiveInspectorStore(runtime, viewId));
}
