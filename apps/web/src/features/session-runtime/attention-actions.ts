import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import { hostId as brandHostId, sessionId as brandSessionId } from "@t4-code/protocol";

import type { PromptOutcome } from "./controller.ts";
import { promptRejectionReason } from "./command-errors.ts";
import { sessionWriteLink } from "./session-inventory.ts";
import {
  CACHED_WRITE_REASON,
  OFFLINE_WRITE_REASON,
  presentSessionControl,
  readSessionControl,
  WriteGateError,
} from "./session-observer.ts";

export interface AttentionActionAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

export type AttentionActionRequest =
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly decision: "approve" | "deny";
    }
  | {
      readonly kind: "question";
      readonly requestId: string;
      readonly optionIds: readonly string[];
      readonly text: string;
    }
  | {
      readonly kind: "plan";
      readonly requestId: string;
      readonly decision: "approve" | "revise" | "reject";
      readonly note?: string;
    }
  | {
      readonly kind: "confirmation";
      readonly requestId: string;
      readonly decision: "approve" | "deny";
    };

const UNKNOWN_REASON =
  "The connection dropped before the host answered. The item stays in the Inbox; check the session before trying again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentIndexedRequest(
  snapshot: DesktopRuntimeSnapshot,
  address: AttentionActionAddress,
  action: Exclude<AttentionActionRequest, { readonly kind: "confirmation" }>,
): boolean {
  const ref = snapshot.projection.sessionIndex.get(`${address.hostId}\u0000${address.sessionId}`);
  const attention = isRecord(Reflect.get(ref ?? {}, "attention"))
    ? Reflect.get(ref ?? {}, "attention")
    : null;
  const pending = attention === null ? null : attention.pending;
  return (
    Array.isArray(pending) &&
    pending.some(
      (item) => isRecord(item) && item.kind === action.kind && item.id === action.requestId,
    )
  );
}

function writeGate(
  snapshot: DesktopRuntimeSnapshot,
  address: AttentionActionAddress,
): { readonly kind: "rejected"; readonly reason: string } | null {
  const link = sessionWriteLink(
    snapshot,
    address.targetId,
    address.hostId,
    address.sessionId,
  );
  if (link === "offline") return { kind: "rejected", reason: OFFLINE_WRITE_REASON };
  if (link === "cached") return { kind: "rejected", reason: CACHED_WRITE_REASON };
  const ref = snapshot.projection.sessionIndex.get(`${address.hostId}\u0000${address.sessionId}`);
  const control = readSessionControl(ref);
  return control === null
    ? null
    : { kind: "rejected", reason: presentSessionControl(control).composerReason };
}

export function attentionResponseArgs(
  action: Exclude<AttentionActionRequest, { readonly kind: "confirmation" }>,
): Record<string, unknown> {
  if (action.kind === "approval") {
    return { requestId: action.requestId, confirmed: action.decision === "approve" };
  }
  if (action.kind === "question") {
    return {
      requestId: action.requestId,
      value: action.text !== "" ? action.text : action.optionIds.join(", "),
    };
  }
  if (action.decision === "approve") return { requestId: action.requestId, confirmed: true };
  if (action.decision === "reject") return { requestId: action.requestId, confirmed: false };
  return { requestId: action.requestId, value: action.note ?? "" };
}

/**
 * Send one Inbox decision without attaching or warming the session transcript.
 * Current host truth is checked again after the prompt-lease wait; a stale card
 * cannot answer a replacement request that happens to occupy the same row.
 */
export async function respondToAttentionItem(
  controller: DesktopRuntimeController,
  address: AttentionActionAddress,
  action: AttentionActionRequest,
): Promise<PromptOutcome> {
  const firstGate = writeGate(controller.getSnapshot(), address);
  if (firstGate !== null) return firstGate;

  if (action.kind === "confirmation") {
    const warm = controller
      .getSnapshot()
      .projection.sessions.get(`${address.hostId}\u0000${address.sessionId}`);
    const challenge = warm?.confirmations.get(action.requestId);
    if (challenge === undefined) {
      return { kind: "rejected", reason: "This approval was already resolved on the host." };
    }
    try {
      const result = await controller.confirm({
        targetId: address.targetId,
        confirmationId: challenge.confirmationId,
        commandId: challenge.commandId,
        hostId: challenge.hostId,
        ...(challenge.sessionId === undefined ? {} : { sessionId: challenge.sessionId }),
        decision: action.decision,
      });
      return result.accepted
        ? { kind: "accepted" }
        : {
            kind: "rejected",
            reason: "The host did not accept this decision. The item stays in the Inbox.",
          };
    } catch {
      return { kind: "unknown", reason: UNKNOWN_REASON };
    }
  }

  const projectionKey = `${address.hostId}\u0000${address.sessionId}`;
  const ref = controller.getSnapshot().projection.sessionIndex.get(projectionKey);
  if (ref === undefined || !currentIndexedRequest(controller.getSnapshot(), address, action)) {
    return { kind: "rejected", reason: "This request was already resolved or replaced." };
  }

  const guard = () => {
    const snapshot = controller.getSnapshot();
    const gated = writeGate(snapshot, address);
    if (gated !== null) throw new WriteGateError(gated.reason);
    if (!currentIndexedRequest(snapshot, address, action)) {
      throw new WriteGateError("This request was already resolved or replaced.");
    }
  };

  try {
    const result = await controller.commandWithPromptLease(
      address.targetId,
      {
        hostId: brandHostId(address.hostId),
        sessionId: brandSessionId(address.sessionId),
        command: "session.ui.respond",
        args: attentionResponseArgs(action),
        expectedRevision: ref.revision,
      },
      undefined,
      guard,
    );
    return result.accepted
      ? { kind: "accepted" }
      : { kind: "rejected", reason: promptRejectionReason(result.error) };
  } catch (error) {
    if (error instanceof WriteGateError) return { kind: "rejected", reason: error.reason };
    return { kind: "unknown", reason: UNKNOWN_REASON };
  }
}
