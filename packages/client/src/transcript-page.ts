import {
  decodeTranscriptPageArguments,
  decodeTranscriptPageResult,
  hostId,
  sessionId,
  type TranscriptPageArguments,
  type TranscriptPageResult,
} from "@t4-code/protocol";
import type { CommandResult } from "@t4-code/protocol/desktop-ipc";
import type { DesktopRuntimeController } from "./desktop-runtime.ts";
import { freezeClone, type DesktopRuntimeSnapshot } from "./desktop-runtime-contracts.ts";

const FEATURE = "transcript.page";
const CAPABILITY = "sessions.read";

export interface TranscriptPageAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

export type TranscriptPageRuntime = Pick<DesktopRuntimeController, "command" | "getSnapshot">;

export class TranscriptPageClientError extends Error {
  readonly code: "invalid" | "offline" | "unsupported" | "command" | "stale";
  readonly remoteCode: string | undefined;

  constructor(code: TranscriptPageClientError["code"], message: string, remoteCode?: string) {
    super(message);
    this.name = "TranscriptPageClientError";
    this.code = code;
    this.remoteCode = remoteCode;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }
}

function commandFailureCode(result: CommandResult): string {
  const code = result.error?.code;
  return typeof code === "string" && code.length > 0 ? code.slice(0, 128) : "command_failed";
}

function requireSupport(snapshot: DesktopRuntimeSnapshot, address: TranscriptPageAddress): void {
  if (
    snapshot.connections.get(address.targetId) !== "connected" ||
    snapshot.targetHosts.get(address.targetId) !== address.hostId
  ) {
    throw new TranscriptPageClientError("offline", "transcript host is offline");
  }
  const metadata = snapshot.hosts.get(address.hostId);
  if (
    metadata === undefined ||
    !metadata.grantedCapabilities.includes(CAPABILITY) ||
    !metadata.grantedFeatures.includes(FEATURE)
  ) {
    throw new TranscriptPageClientError(
      "unsupported",
      "this host does not offer bounded transcript pages",
    );
  }
}

/**
 * Read one chronological transcript page without attaching the live stream.
 * The `before` token is opaque history state and must never be reused as the
 * live `{ epoch, seq }` cursor accepted by `session.attach`.
 */
export async function readTranscriptPage(
  runtime: TranscriptPageRuntime,
  address: TranscriptPageAddress,
  args: TranscriptPageArguments = {},
): Promise<TranscriptPageResult> {
  let normalized: TranscriptPageArguments;
  try {
    normalized = freezeClone(decodeTranscriptPageArguments(args));
  } catch {
    throw new TranscriptPageClientError("invalid", "transcript page arguments are invalid");
  }

  const beforeSnapshot = runtime.getSnapshot();
  requireSupport(beforeSnapshot, address);
  const capturedEpoch = beforeSnapshot.hosts.get(address.hostId)?.epoch;
  const result = await runtime.command(address.targetId, {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command: "transcript.page",
    args: { ...normalized },
  });
  const afterSnapshot = runtime.getSnapshot();
  try {
    requireSupport(afterSnapshot, address);
  } catch {
    throw new TranscriptPageClientError(
      "stale",
      "the transcript page completed after its target connection changed",
      "target_rebound",
    );
  }
  if (afterSnapshot.hosts.get(address.hostId)?.epoch !== capturedEpoch) {
    throw new TranscriptPageClientError(
      "stale",
      "the transcript page completed after its host generation changed",
      "target_rebound",
    );
  }
  if (!result.accepted) {
    const remoteCode = commandFailureCode(result);
    if (remoteCode === "transcript_cursor_stale") {
      throw new TranscriptPageClientError(
        "stale",
        "the transcript changed while older history was loading",
        remoteCode,
      );
    }
    if (
      remoteCode === "unsupported" ||
      remoteCode === "feature_required" ||
      remoteCode === "capability_denied"
    ) {
      throw new TranscriptPageClientError(
        "unsupported",
        "this host does not offer bounded transcript pages",
        remoteCode,
      );
    }
    throw new TranscriptPageClientError(
      "command",
      "the host could not read this transcript page",
      remoteCode,
    );
  }

  try {
    const decoded = decodeTranscriptPageResult(result.result);
    if (
      decoded.entries.some(
        (entry) => entry.hostId !== address.hostId || entry.sessionId !== address.sessionId,
      )
    ) {
      throw new Error("transcript page contains entries from another session");
    }
    return freezeClone(decoded);
  } catch {
    throw new TranscriptPageClientError(
      "command",
      "the host returned an invalid transcript page",
      "invalid_result",
    );
  }
}

export type { TranscriptPageArguments, TranscriptPageResult } from "@t4-code/protocol";
