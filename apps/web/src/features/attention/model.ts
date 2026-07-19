export interface AttentionSessionIdentity {
  readonly targetId?: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly project: string;
  /** Only set when the host adds useful context beyond the project name. */
  readonly hostLabel?: string;
}

export type AttentionActionStatus =
  | "ready"
  | "resolving"
  | "offline"
  | "observer"
  | "expired"
  | "stale"
  | "unsupported"
  | "error";

export interface AttentionActionState {
  readonly status: AttentionActionStatus;
  /** A safe, plain-English explanation supplied by the live action adapter. */
  readonly message?: string;
}

interface AttentionItemBase {
  readonly key: string;
  readonly session: AttentionSessionIdentity;
  readonly title: string;
  readonly summary: string;
  readonly occurredAtMs: number;
}

interface BlockingAttentionItemBase extends AttentionItemBase {
  readonly requestId: string;
  readonly actionState: AttentionActionState;
}

export interface AttentionApprovalItem extends BlockingAttentionItemBase {
  readonly kind: "approval";
}

export interface AttentionQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface AttentionQuestionItem extends BlockingAttentionItemBase {
  readonly kind: "question";
  readonly options: readonly AttentionQuestionOption[];
  readonly allowText: boolean;
  readonly multiple: boolean;
}

export interface AttentionPlanItem extends BlockingAttentionItemBase {
  readonly kind: "plan";
}

export interface AttentionConfirmationItem extends BlockingAttentionItemBase {
  readonly kind: "confirmation";
  readonly expiresAtMs: number;
}

export interface AttentionOutcomeItem extends AttentionItemBase {
  readonly kind: "failed" | "cancelled" | "completed";
  readonly outcomeId: string;
  readonly seen: boolean;
}

export type AttentionFailedItem = AttentionOutcomeItem & { readonly kind: "failed" };

export type AttentionCancelledItem = AttentionOutcomeItem & { readonly kind: "cancelled" };

export type AttentionCompletedItem = AttentionOutcomeItem & { readonly kind: "completed" };

export type BlockingAttentionItem =
  | AttentionApprovalItem
  | AttentionQuestionItem
  | AttentionPlanItem
  | AttentionConfirmationItem;

export type AttentionInboxItem = BlockingAttentionItem | AttentionOutcomeItem;

export type AttentionInboxAction =
  | {
      readonly kind: "approval";
      readonly itemKey: string;
      readonly requestId: string;
      readonly decision: "approve" | "deny";
    }
  | {
      readonly kind: "question";
      readonly itemKey: string;
      readonly requestId: string;
      readonly optionIds: readonly string[];
      readonly text: string;
    }
  | {
      readonly kind: "plan";
      readonly itemKey: string;
      readonly requestId: string;
      readonly decision: "approve" | "revise" | "reject";
    }
  | {
      readonly kind: "confirmation";
      readonly itemKey: string;
      readonly requestId: string;
      readonly decision: "approve" | "deny";
    };

export interface AttentionInventoryState {
  readonly status: "complete" | "partial" | "offline";
  readonly message?: string;
}

export type AttentionSectionId = "needs-you" | "problems" | "done";

export interface AttentionInboxSection<T extends AttentionInboxItem = AttentionInboxItem> {
  readonly id: AttentionSectionId;
  readonly label: string;
  readonly description: string;
  readonly items: readonly T[];
}

export interface AttentionInboxViewModel {
  readonly sections: readonly [
    AttentionInboxSection<BlockingAttentionItem>,
    AttentionInboxSection<AttentionFailedItem | AttentionCancelledItem>,
    AttentionInboxSection<AttentionCompletedItem>,
  ];
  readonly urgentCount: number;
  readonly unseenDoneCount: number;
  readonly unseenOutcomeCount: number;
  readonly totalCount: number;
}

export function isBlockingAttentionItem(item: AttentionInboxItem): item is BlockingAttentionItem {
  return (
    item.kind === "approval" ||
    item.kind === "question" ||
    item.kind === "plan" ||
    item.kind === "confirmation"
  );
}

export function isOutcomeAttentionItem(item: AttentionInboxItem): item is AttentionOutcomeItem {
  return item.kind === "failed" || item.kind === "cancelled" || item.kind === "completed";
}

export function canRespondToAttentionItem(item: BlockingAttentionItem): boolean {
  return item.actionState.status === "ready" || item.actionState.status === "error";
}

function compareKey(left: AttentionInboxItem, right: AttentionInboxItem): number {
  return left.key.localeCompare(right.key);
}

function compareNeedsYou(left: BlockingAttentionItem, right: BlockingAttentionItem): number {
  const leftExpired = left.actionState.status === "expired";
  const rightExpired = right.actionState.status === "expired";
  if (leftExpired !== rightExpired) return leftExpired ? 1 : -1;

  const leftExpiry = left.kind === "confirmation" ? left.expiresAtMs : Number.POSITIVE_INFINITY;
  const rightExpiry = right.kind === "confirmation" ? right.expiresAtMs : Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  return left.occurredAtMs - right.occurredAtMs || compareKey(left, right);
}

function compareNewest(left: AttentionOutcomeItem, right: AttentionOutcomeItem): number {
  return right.occurredAtMs - left.occurredAtMs || compareKey(left, right);
}

/**
 * Build the renderer-only projection. Runtime truth stays in the client and
 * host layers; this function only de-duplicates, groups, orders, and counts.
 */
export function buildAttentionInboxViewModel(
  items: readonly AttentionInboxItem[],
): AttentionInboxViewModel {
  const uniqueItems = [...new Map(items.map((item) => [item.key, item])).values()];
  const needsYou = uniqueItems.filter(isBlockingAttentionItem).sort(compareNeedsYou);
  const problems = uniqueItems
    .filter(
      (item): item is AttentionFailedItem | AttentionCancelledItem =>
        item.kind === "failed" || item.kind === "cancelled",
    )
    .sort(compareNewest);
  const done = uniqueItems
    .filter((item): item is AttentionCompletedItem => item.kind === "completed")
    .sort(compareNewest);
  const unseenProblems = problems.filter((item) => !item.seen).length;
  const unseenDoneCount = done.filter((item) => !item.seen).length;

  return {
    sections: [
      {
        id: "needs-you",
        label: "Needs you",
        description: "Questions and decisions that are holding up work",
        items: needsYou,
      },
      {
        id: "problems",
        label: "Problems",
        description: "Failed or cancelled work that has not been reviewed",
        items: problems,
      },
      {
        id: "done",
        label: "Done",
        description: "The latest completed work from each session",
        items: done,
      },
    ],
    urgentCount: needsYou.length + unseenProblems,
    unseenDoneCount,
    unseenOutcomeCount: unseenProblems + unseenDoneCount,
    totalCount: uniqueItems.length,
  };
}

export function formatAttentionAge(occurredAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - occurredAtMs) / 1_000));
  if (elapsedSeconds < 60) return "now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d`;
}

export function formatAttentionExpiry(expiresAtMs: number, nowMs: number): string {
  const remainingSeconds = Math.ceil((expiresAtMs - nowMs) / 1_000);
  if (remainingSeconds <= 0) return "Expired";
  if (remainingSeconds < 60) return `Expires in ${remainingSeconds}s`;
  return `Expires in ${Math.ceil(remainingSeconds / 60)}m`;
}
