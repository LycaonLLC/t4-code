import {
  Badge,
  Button,
  cn,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  IconButton,
  Spinner,
} from "@t4-code/ui";
import {
  ArrowLeft,
  Ban,
  Check,
  CircleCheck,
  CircleHelp,
  CircleX,
  CloudOff,
  Inbox,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  buildAttentionInboxViewModel,
  canRespondToAttentionItem,
  formatAttentionAge,
  formatAttentionExpiry,
  isOutcomeAttentionItem,
  type AttentionActionState,
  type AttentionInboxAction,
  type AttentionInboxItem,
  type AttentionInboxSection,
  type AttentionInventoryState,
  type AttentionOutcomeItem,
  type AttentionQuestionItem,
  type AttentionSessionIdentity,
  type BlockingAttentionItem,
} from "./model.ts";

type InboxFilter = "open" | "seen";

export interface AttentionInboxScreenProps {
  readonly items: readonly AttentionInboxItem[];
  readonly inventory: AttentionInventoryState;
  readonly nowMs?: number | undefined;
  readonly onAction: (action: AttentionInboxAction) => void;
  readonly onOpenSession: (session: AttentionSessionIdentity) => void;
  readonly onMarkSeen: (itemKey: string) => void;
  readonly onMarkAllUpdatesSeen: () => void;
  readonly onBack?: () => void;
}

const ITEM_PRESENTATION: Readonly<
  Record<
    AttentionInboxItem["kind"],
    {
      readonly label: string;
      readonly icon: LucideIcon;
      readonly dot: string;
      readonly text: string;
    }
  >
> = {
  approval: {
    label: "Approval",
    icon: ShieldCheck,
    dot: "bg-status-approval-dot",
    text: "text-status-approval",
  },
  question: {
    label: "Question",
    icon: CircleHelp,
    dot: "bg-status-input-dot",
    text: "text-status-input",
  },
  plan: {
    label: "Plan review",
    icon: ListChecks,
    dot: "bg-status-plan-dot",
    text: "text-status-plan",
  },
  confirmation: {
    label: "Security check",
    icon: ShieldAlert,
    dot: "bg-status-approval-dot",
    text: "text-status-approval",
  },
  failed: {
    label: "Failed",
    icon: CircleX,
    dot: "bg-status-error-dot",
    text: "text-status-error",
  },
  cancelled: {
    label: "Cancelled",
    icon: Ban,
    dot: "bg-status-error-dot",
    text: "text-status-error",
  },
  completed: {
    label: "Completed",
    icon: CircleCheck,
    dot: "bg-status-done-dot",
    text: "text-status-done",
  },
};

const ACTION_STATE_COPY: Readonly<
  Record<
    AttentionActionState["status"],
    { readonly label: string; readonly tone: string; readonly live?: boolean }
  >
> = {
  ready: { label: "Ready", tone: "text-muted-foreground" },
  resolving: { label: "Sending response", tone: "text-status-working", live: true },
  offline: { label: "Reconnect to answer", tone: "text-warning-foreground" },
  observer: { label: "Active in another app", tone: "text-warning-foreground" },
  expired: { label: "Expired", tone: "text-muted-foreground" },
  stale: { label: "Open session to refresh", tone: "text-warning-foreground" },
  unsupported: { label: "Open session to respond", tone: "text-muted-foreground" },
  error: { label: "Response failed", tone: "text-destructive-foreground" },
};

function itemMetadata(item: AttentionInboxItem): string {
  const parts = [item.session.project];
  if (item.session.hostLabel !== undefined && item.session.hostLabel !== item.session.project) {
    parts.push(item.session.hostLabel);
  }
  return parts.join(" · ");
}

function ActionStateLabel({ state }: { readonly state: AttentionActionState }) {
  const copy = ACTION_STATE_COPY[state.status];
  if (state.status === "ready") return null;
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5 text-xs", copy.tone)}
      role={state.status === "error" ? "alert" : "status"}
    >
      {copy.live ? (
        <Spinner aria-hidden="true" className="size-3.5" />
      ) : (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      )}
      <span>{state.message ?? copy.label}</span>
    </div>
  );
}

function ApprovalActions({
  item,
  onAction,
}: {
  readonly item: Extract<BlockingAttentionItem, { kind: "approval" }>;
  readonly onAction: (action: AttentionInboxAction) => void;
}) {
  const disabled = !canRespondToAttentionItem(item);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() =>
          onAction({
            kind: "approval",
            itemKey: item.key,
            requestId: item.requestId,
            decision: "approve",
          })
        }
        size="xs"
      >
        <Check aria-hidden="true" />
        Approve
      </Button>
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() =>
          onAction({
            kind: "approval",
            itemKey: item.key,
            requestId: item.requestId,
            decision: "deny",
          })
        }
        size="xs"
        variant="destructive-outline"
      >
        <X aria-hidden="true" />
        Deny
      </Button>
    </div>
  );
}

function ConfirmationActions({
  item,
  onAction,
}: {
  readonly item: Extract<BlockingAttentionItem, { kind: "confirmation" }>;
  readonly onAction: (action: AttentionInboxAction) => void;
}) {
  const disabled = !canRespondToAttentionItem(item);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() =>
          onAction({
            kind: "confirmation",
            itemKey: item.key,
            requestId: item.requestId,
            decision: "approve",
          })
        }
        size="xs"
      >
        Confirm
      </Button>
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() =>
          onAction({
            kind: "confirmation",
            itemKey: item.key,
            requestId: item.requestId,
            decision: "deny",
          })
        }
        size="xs"
        variant="destructive-outline"
      >
        Deny
      </Button>
    </div>
  );
}

function PlanActions({
  item,
  onAction,
}: {
  readonly item: Extract<BlockingAttentionItem, { kind: "plan" }>;
  readonly onAction: (action: AttentionInboxAction) => void;
}) {
  const disabled = !canRespondToAttentionItem(item);
  const respond = (decision: "approve" | "revise" | "reject") =>
    onAction({ kind: "plan", itemKey: item.key, requestId: item.requestId, decision });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() => respond("approve")}
        size="xs"
      >
        Approve and start
      </Button>
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() => respond("revise")}
        size="xs"
        variant="outline"
      >
        Revise
      </Button>
      <Button
        className="min-h-11 sm:min-h-0"
        disabled={disabled}
        onClick={() => respond("reject")}
        size="xs"
        variant="ghost"
      >
        Reject
      </Button>
    </div>
  );
}

function QuestionActions({
  item,
  onAction,
}: {
  readonly item: AttentionQuestionItem;
  readonly onAction: (action: AttentionInboxAction) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const disabled = !canRespondToAttentionItem(item);

  const submit = (optionIds = selected, answer = text) => {
    const cleanText = answer.trim();
    if (optionIds.length === 0 && cleanText.length === 0) return;
    onAction({
      kind: "question",
      itemKey: item.key,
      requestId: item.requestId,
      optionIds,
      text: cleanText,
    });
  };

  const choose = (optionId: string) => {
    if (!item.multiple) {
      submit([optionId], "");
      return;
    }
    setSelected((current) =>
      current.includes(optionId)
        ? current.filter((selectedId) => selectedId !== optionId)
        : [...current, optionId],
    );
  };

  return (
    <div className="flex max-w-2xl flex-col gap-2">
      {item.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer choices">
          {item.options.map((option) => {
            const active = selected.includes(option.id);
            return (
              <Button
                aria-pressed={item.multiple ? active : undefined}
                className="min-h-11 max-w-full whitespace-normal text-left sm:min-h-0"
                disabled={disabled}
                key={option.id}
                onClick={() => choose(option.id)}
                size="xs"
                title={option.detail}
                variant={active ? "secondary" : "outline"}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
      )}
      {(item.allowText || item.multiple) && (
        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row">
          {item.allowText && (
            <input
              aria-label="Answer in your own words"
              className="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-7"
              disabled={disabled}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Answer in your own words"
              type="text"
              value={text}
            />
          )}
          <Button
            className="min-h-11 sm:min-h-0"
            disabled={disabled || (selected.length === 0 && text.trim().length === 0)}
            onClick={() => submit()}
            size="xs"
          >
            Answer
          </Button>
        </div>
      )}
    </div>
  );
}

function BlockingActions({
  item,
  onAction,
}: {
  readonly item: BlockingAttentionItem;
  readonly onAction: (action: AttentionInboxAction) => void;
}) {
  switch (item.kind) {
    case "approval":
      return <ApprovalActions item={item} onAction={onAction} />;
    case "question":
      return <QuestionActions item={item} onAction={onAction} />;
    case "plan":
      return <PlanActions item={item} onAction={onAction} />;
    case "confirmation":
      return <ConfirmationActions item={item} onAction={onAction} />;
  }
}

function AttentionRow({
  item,
  nowMs,
  onAction,
  onOpenSession,
  onMarkSeen,
  onRowFocus,
  setRowRef,
}: {
  readonly item: AttentionInboxItem;
  readonly nowMs: number;
  readonly onAction: (action: AttentionInboxAction) => void;
  readonly onOpenSession: (session: AttentionSessionIdentity) => void;
  readonly onMarkSeen: (itemKey: string) => void;
  readonly onRowFocus: (itemKey: string) => void;
  readonly setRowRef: (itemKey: string, element: HTMLLIElement | null) => void;
}) {
  const presentation = ITEM_PRESENTATION[item.kind];
  const Icon = presentation.icon;
  const outcome = isOutcomeAttentionItem(item) ? item : null;
  const openSession = () => {
    if (outcome !== null && !outcome.seen) onMarkSeen(outcome.key);
    onOpenSession(item.session);
  };
  const dateTime = Number.isFinite(item.occurredAtMs)
    ? new Date(item.occurredAtMs).toISOString()
    : undefined;

  return (
    <li
      className="scroll-m-4 px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
      data-attention-key={item.key}
      onFocusCapture={() => onRowFocus(item.key)}
      ref={(element) => setRowRef(item.key, element)}
      tabIndex={-1}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", presentation.text)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-medium text-xs",
                presentation.text,
              )}
            >
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", presentation.dot)} />
              {presentation.label}
            </span>
            {outcome !== null && !outcome.seen && (
              <Badge size="sm" variant="outline">
                New
              </Badge>
            )}
            <span className="min-w-0 truncate text-muted-foreground text-xs">
              {itemMetadata(item)}
            </span>
            <time
              className="ms-auto shrink-0 font-mono text-muted-foreground text-xs"
              dateTime={dateTime}
            >
              {formatAttentionAge(item.occurredAtMs, nowMs)}
            </time>
          </div>
          <h3 className="mt-1 font-medium text-sm leading-snug">{item.title}</h3>
          <p className="mt-0.5 max-w-[72ch] text-muted-foreground text-sm leading-relaxed">
            {item.summary}
          </p>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            Session: {item.session.title}
          </p>
          {item.kind === "confirmation" && (
            <p className="mt-1 font-medium text-status-approval text-xs">
              {formatAttentionExpiry(item.expiresAtMs, nowMs)}
            </p>
          )}
          <div className="mt-2 flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {isOutcomeAttentionItem(item) ? (
              !item.seen && (
                <Button
                  className="min-h-11 sm:min-h-0"
                  onClick={() => onMarkSeen(item.key)}
                  size="xs"
                  variant="ghost"
                >
                  Mark seen
                </Button>
              )
            ) : (
              <BlockingActions item={item} onAction={onAction} />
            )}
            <Button
              className="min-h-11 sm:ms-auto sm:min-h-0"
              onClick={openSession}
              size="xs"
              variant="ghost"
            >
              Open session
            </Button>
          </div>
          {!isOutcomeAttentionItem(item) && (
            <div className="mt-2">
              <ActionStateLabel state={item.actionState} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function InventoryNotice({ inventory }: { readonly inventory: AttentionInventoryState }) {
  if (inventory.status === "complete") return null;
  const offline = inventory.status === "offline";
  const Icon = offline ? CloudOff : TriangleAlert;
  const defaultMessage = offline
    ? "Hosts are offline. Saved items stay visible, but answers cannot be sent until a host reconnects."
    : "Some host session lists are incomplete. More items may appear after those hosts refresh.";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
        offline
          ? "border-warning/24 bg-warning/4 text-warning-foreground dark:bg-warning/8"
          : "border-info/24 bg-info/4 text-info-foreground dark:bg-info/8",
      )}
      role="status"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{inventory.message ?? defaultMessage}</p>
    </div>
  );
}

function AttentionSection({
  section,
  items,
  nowMs,
  callbacks,
}: {
  readonly section: AttentionInboxSection;
  readonly items: readonly AttentionInboxItem[];
  readonly nowMs: number;
  readonly callbacks: {
    readonly onAction: (action: AttentionInboxAction) => void;
    readonly onOpenSession: (session: AttentionSessionIdentity) => void;
    readonly onMarkSeen: (itemKey: string) => void;
    readonly onRowFocus: (itemKey: string) => void;
    readonly setRowRef: (itemKey: string, element: HTMLLIElement | null) => void;
  };
}) {
  if (items.length === 0) return null;
  const headingId = `attention-${section.id}-heading`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-1.5 flex items-baseline gap-2 px-1">
        <h2 className="font-heading font-semibold text-sm" id={headingId}>
          {section.label}
        </h2>
        <span className="font-mono text-muted-foreground text-xs">{items.length}</span>
        <span className="hidden text-muted-foreground text-xs sm:inline">
          {section.description}
        </span>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {items.map((item) => (
          <AttentionRow item={item} key={item.key} nowMs={nowMs} {...callbacks} />
        ))}
      </ul>
    </section>
  );
}

function filterSectionItems(
  section: AttentionInboxSection,
  filter: InboxFilter,
): readonly AttentionInboxItem[] {
  if (filter === "open") {
    return section.items.filter(
      (item) => !isOutcomeAttentionItem(item) || (isOutcomeAttentionItem(item) && !item.seen),
    );
  }
  return section.items.filter(
    (item): item is AttentionOutcomeItem => isOutcomeAttentionItem(item) && item.seen,
  );
}

function EmptyInbox({
  filter,
  inventory,
  focusRef,
}: {
  readonly filter: InboxFilter;
  readonly inventory: AttentionInventoryState;
  readonly focusRef: React.RefObject<HTMLDivElement | null>;
}) {
  const partial = inventory.status !== "complete";
  const title =
    filter === "seen"
      ? "No seen updates"
      : partial
        ? "Nothing is visible right now"
        : "All caught up";
  const description =
    filter === "seen"
      ? "Completed and failed work appears here after you mark it seen."
      : partial
        ? "This view may change when every host finishes reconnecting and refreshing its sessions."
        : "There are no questions, decisions, problems, or new completed turns waiting for you.";
  return (
    <Empty
      className="min-h-64 rounded-lg border border-border border-dashed"
      ref={focusRef}
      tabIndex={-1}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function AttentionInboxScreen({
  items,
  inventory,
  nowMs = Date.now(),
  onAction,
  onOpenSession,
  onMarkSeen,
  onMarkAllUpdatesSeen,
  onBack,
}: AttentionInboxScreenProps) {
  const [filter, setFilter] = useState<InboxFilter>("open");
  const model = useMemo(() => buildAttentionInboxViewModel(items), [items]);
  const filteredSections = model.sections.map((section) => ({
    section,
    items: filterSectionItems(section, filter),
  }));
  const visibleItems = filteredSections.flatMap((entry) => entry.items);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focusedKeyRef = useRef<string | null>(null);
  const previousKeysRef = useRef<readonly string[]>(visibleItems.map((item) => item.key));
  const emptyFocusRef = useRef<HTMLDivElement | null>(null);
  const openTabRef = useRef<HTMLButtonElement | null>(null);
  const seenTabRef = useRef<HTMLButtonElement | null>(null);

  const selectTab = (next: InboxFilter, moveFocus = false) => {
    setFilter(next);
    if (moveFocus) (next === "open" ? openTabRef : seenTabRef).current?.focus();
  };

  useLayoutEffect(() => {
    const previousKeys = previousKeysRef.current;
    const nextKeys = visibleItems.map((item) => item.key);
    const focusedKey = focusedKeyRef.current;
    if (
      focusedKey !== null &&
      !nextKeys.includes(focusedKey) &&
      previousKeys.includes(focusedKey)
    ) {
      const removedIndex = previousKeys.indexOf(focusedKey);
      const remaining = nextKeys[removedIndex] ?? nextKeys[removedIndex - 1];
      if (remaining !== undefined) rowRefs.current.get(remaining)?.focus();
      else emptyFocusRef.current?.focus();
      focusedKeyRef.current = remaining ?? null;
    }
    previousKeysRef.current = nextKeys;
  }, [visibleItems]);

  const callbacks = {
    onAction,
    onOpenSession,
    onMarkSeen,
    onRowFocus: (itemKey: string) => {
      focusedKeyRef.current = itemKey;
    },
    setRowRef: (itemKey: string, element: HTMLLIElement | null) => {
      if (element === null) rowRefs.current.delete(itemKey);
      else rowRefs.current.set(itemKey, element);
    },
  };
  const countAnnouncement = `${model.urgentCount} urgent, ${model.unseenDoneCount} completed, ${model.totalCount} total inbox items.`;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-border border-b px-4 py-2">
        {onBack !== undefined && (
          <IconButton aria-label="Back to sessions" onClick={onBack} size="icon-sm">
            <ArrowLeft />
          </IconButton>
        )}
        <Inbox aria-hidden="true" className="size-4 text-muted-foreground" />
        <h1 className="font-heading font-semibold text-base">Attention inbox</h1>
        <p aria-live="polite" className="sr-only" role="status">
          {countAnnouncement}
        </p>
        <div className="ms-auto hidden items-center gap-2 text-muted-foreground text-xs sm:flex">
          <span>{model.sections[0].items.length} need you</span>
          <span aria-hidden="true">·</span>
          <span>
            {model.sections[1].items.length}{" "}
            {model.sections[1].items.length === 1 ? "problem" : "problems"}
          </span>
          <span aria-hidden="true">·</span>
          <span>{model.sections[2].items.length} done</span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex max-w-4xl flex-col gap-4 pt-4 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(1rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]">
          <InventoryNotice inventory={inventory} />
          <div className="flex flex-wrap items-center gap-2">
            <div
              aria-label="Inbox view"
              className="inline-flex rounded-lg border border-input bg-secondary p-0.5"
              role="tablist"
            >
              <Button
                aria-controls="attention-inbox-panel"
                aria-selected={filter === "open"}
                id="attention-inbox-tab-open"
                onClick={() => selectTab("open")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "End") return;
                  event.preventDefault();
                  selectTab("seen", true);
                }}
                ref={openTabRef}
                role="tab"
                size="xs"
                tabIndex={filter === "open" ? 0 : -1}
                variant={filter === "open" ? "outline" : "ghost"}
              >
                Open
                {model.urgentCount + model.unseenDoneCount > 0 && (
                  <span className="font-mono text-[.625rem]">
                    {model.urgentCount + model.unseenDoneCount}
                  </span>
                )}
              </Button>
              <Button
                aria-controls="attention-inbox-panel"
                aria-selected={filter === "seen"}
                id="attention-inbox-tab-seen"
                onClick={() => selectTab("seen")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "Home") return;
                  event.preventDefault();
                  selectTab("open", true);
                }}
                ref={seenTabRef}
                role="tab"
                size="xs"
                tabIndex={filter === "seen" ? 0 : -1}
                variant={filter === "seen" ? "outline" : "ghost"}
              >
                Seen
              </Button>
            </div>
            {filter === "open" && model.unseenOutcomeCount > 0 && (
              <Button
                className="ms-auto min-h-11 sm:min-h-0"
                onClick={onMarkAllUpdatesSeen}
                size="xs"
                variant="ghost"
              >
                Mark all updates seen
              </Button>
            )}
          </div>
          <div
            aria-label={`${filter === "open" ? "Open" : "Seen"} inbox items`}
            aria-labelledby={`attention-inbox-tab-${filter}`}
            id="attention-inbox-panel"
            role="tabpanel"
          >
            {visibleItems.length === 0 ? (
              <EmptyInbox filter={filter} focusRef={emptyFocusRef} inventory={inventory} />
            ) : (
              <div className="flex flex-col gap-5">
                {filteredSections.map(({ section, items: sectionItems }) => (
                  <AttentionSection
                    callbacks={callbacks}
                    items={sectionItems}
                    key={section.id}
                    nowMs={nowMs}
                    section={section}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
