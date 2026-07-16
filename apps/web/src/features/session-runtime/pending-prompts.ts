import { retainedText } from "@t4-code/client";
import type { SessionRef } from "@t4-code/protocol";

import {
  boundedAttachmentCount,
  MAX_ACCEPTED_PENDING_PROMPTS,
  type PendingPrompt,
} from "../transcript/projection.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pendingPromptFromValue(value: unknown): PendingPrompt | null {
  if (!isRecord(value)) return null;
  const { entryId, text, at } = value;
  if (
    typeof entryId !== "string" ||
    entryId.length === 0 ||
    entryId.length > 512 ||
    typeof text !== "string" ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at))
  ) {
    return null;
  }
  return {
    entryId,
    text: retainedText(text, 8 * 1024),
    attachmentCount: boundedAttachmentCount(value.attachmentCount),
    at,
  };
}

/**
 * Parse authoritative accepted-prompt state. A present plural field wins even
 * when empty or malformed; singular state is only a transition fallback for
 * older hosts that do not emit `pendingPrompts` yet.
 */
export function pendingPromptsFromRef(ref: SessionRef | undefined): readonly PendingPrompt[] {
  if (!isRecord(ref?.liveState)) return [];
  if (Object.hasOwn(ref.liveState, "pendingPrompts")) {
    const plural = ref.liveState.pendingPrompts;
    if (!Array.isArray(plural)) return [];
    const prompts: PendingPrompt[] = [];
    const seen = new Set<string>();
    for (const value of plural.slice(0, MAX_ACCEPTED_PENDING_PROMPTS)) {
      const prompt = pendingPromptFromValue(value);
      if (prompt === null || seen.has(prompt.entryId)) continue;
      seen.add(prompt.entryId);
      prompts.push(prompt);
    }
    return prompts;
  }
  const legacy = pendingPromptFromValue(ref.liveState.pendingPrompt);
  return legacy === null ? [] : [legacy];
}
