// Attention panels that stack above the composer: approval, question (ask),
// plan review, and turn errors. Panel placement and keyboard handling follow
// T3's composer pending panels (ComposerPendingApprovalPanel /
// ComposerPendingUserInputPanel, MIT, T3 Tools Inc., commit
// f61fa9499d96fee825492aba204593c37b27e0cb), rebuilt on OMP tokens with the
// fixed status taxonomy: approval=amber, input=indigo, plan=violet,
// error=red. Every panel is a focusable region with a visible label; digits
// 1–9 answer questions, y/n answers approvals.
import { AnimatedHeight, Button, cn } from "@t4-code/ui";
import { Check, CircleAlert, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "../transcript/Markdown.tsx";
import type {
  ApprovalRequest,
  AskRequest,
  PlanProposal,
  TranscriptNotice,
} from "../transcript/projection.ts";
import type { SessionIntent } from "../session-runtime/intents.ts";
import { resolveAskDigit } from "./keys.ts";

interface PanelChromeProps {
  readonly label: string;
  readonly dotClass: string;
  readonly children: React.ReactNode;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

function PanelChrome({ label, dotClass, children, onKeyDown }: PanelChromeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Move focus to the panel when it appears so keyboard answers work at once;
  // focus restoration back to the composer happens at the call site.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      aria-label={label}
      className="rounded-xl border border-border bg-popover shadow-(--composer-shadow) outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={onKeyDown}
      ref={ref}
      role="region"
      tabIndex={-1}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClass)} />
        <span className="font-medium text-xs">{label}</span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export function ApprovalPanel({
  approval,
  onIntent,
}: {
  readonly approval: ApprovalRequest;
  readonly onIntent: (intent: SessionIntent) => void;
}) {
  const respond = (decision: "approve" | "deny") =>
    onIntent({ kind: "approval", approvalId: approval.approvalId, decision });
  return (
    <PanelChrome
      dotClass="bg-status-approval-dot"
      label="Approval needed"
      onKeyDown={(event) => {
        if (event.key === "y" || event.key === "Y") {
          event.preventDefault();
          respond("approve");
        } else if (event.key === "n" || event.key === "N") {
          event.preventDefault();
          respond("deny");
        }
      }}
    >
      <div className="space-y-2 px-3 pb-3">
        <p className="pt-1 text-muted-foreground text-xs">It wants to run this command:</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-(--markdown-codeblock-background) px-2.5 py-1.5 font-mono text-xs">
          {approval.command}
        </pre>
        {Object.keys(approval.args).length > 0 && (
          <pre className="overflow-x-auto rounded-md border border-border/60 px-2.5 py-1.5 font-mono text-muted-foreground text-xs">
            {JSON.stringify(approval.args, null, 2)}
          </pre>
        )}
        <div className="flex items-center gap-2 pt-0.5">
          <Button className="min-h-11 sm:min-h-0" onClick={() => respond("approve")} size="sm">
            <Check aria-hidden="true" />
            Approve
          </Button>
          <Button className="min-h-11 sm:min-h-0" onClick={() => respond("deny")} size="sm" variant="destructive-outline">
            <X aria-hidden="true" />
            Deny
          </Button>
          <span className="hidden text-muted-foreground text-xs sm:inline">y approves · n denies</span>
        </div>
      </div>
    </PanelChrome>
  );
}

// ---------------------------------------------------------------------------
// Ask (question)
// ---------------------------------------------------------------------------

export function AskPanel({
  ask,
  onIntent,
}: {
  readonly ask: AskRequest;
  readonly onIntent: (intent: SessionIntent) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [freeText, setFreeText] = useState("");

  const toggle = (optionId: string) => {
    if (ask.multiple) {
      setSelected((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      );
      return;
    }
    // Single choice answers immediately — one keystroke, done.
    onIntent({ kind: "ask", askId: ask.askId, optionIds: [optionId], text: "" });
  };

  const submitSelection = () => {
    if (selected.length === 0 && freeText.trim() === "") return;
    onIntent({ kind: "ask", askId: ask.askId, optionIds: selected, text: freeText.trim() });
  };

  return (
    <PanelChrome
      dotClass="bg-status-input-dot"
      label="Waiting on your answer"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        const digit = resolveAskDigit(
          {
            key: event.key,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
          },
          ask.options.length,
        );
        if (digit !== null) {
          event.preventDefault();
          const option = ask.options[digit];
          if (option !== undefined) toggle(option.id);
        }
      }}
    >
      <div className="space-y-2 px-3 pb-3">
        <p className="pt-1 text-sm">{ask.question}</p>
        <ol className="space-y-1">
          {ask.options.map((option, index) => {
            const active = selected.includes(option.id);
            return (
              <li key={option.id}>
                <button
                  aria-pressed={ask.multiple ? active : undefined}
                  className={cn(
                    "flex min-h-11 w-full cursor-pointer items-baseline gap-2 rounded-md border border-transparent px-2 py-1.5 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
                    active && "border-input bg-secondary",
                  )}
                  onClick={() => toggle(option.id)}
                  type="button"
                >
                  <span className="w-4 shrink-0 text-right font-mono text-muted-foreground text-xs">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm">{option.label}</span>
                    {option.detail !== null && (
                      <span className="block text-muted-foreground text-xs">{option.detail}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {ask.allowText && (
          <input
            aria-label="Answer in your own words"
            className="h-11 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
            onChange={(event) => setFreeText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitSelection();
              }
            }}
            placeholder="Or answer in your own words"
            type="text"
            value={freeText}
          />
        )}
        {(ask.multiple || ask.allowText) && (
          <div className="flex items-center gap-2">
            <Button
              className="min-h-11 sm:min-h-0"
              disabled={selected.length === 0 && freeText.trim() === ""}
              onClick={submitSelection}
              size="sm"
            >
              Answer
            </Button>
            <span className="text-muted-foreground text-xs">Press 1–9 to pick an option</span>
          </div>
        )}
        {!ask.multiple && !ask.allowText && (
          <p className="text-muted-foreground text-xs">Press 1–9 to pick an option</p>
        )}
      </div>
    </PanelChrome>
  );
}

// ---------------------------------------------------------------------------
// Plan review
// ---------------------------------------------------------------------------

export function PlanPanel({
  plan,
  onIntent,
  onRevise,
}: {
  readonly plan: PlanProposal;
  readonly onIntent: (intent: SessionIntent) => void;
  /** Focus the composer with a revision seam; the note travels as a plan intent. */
  readonly onRevise: () => void;
}) {
  return (
    <PanelChrome dotClass="bg-status-plan-dot" label="Plan ready">
      <div className="space-y-2 px-3 pb-3">
        <p className="pt-1 font-medium text-sm">{plan.title}</p>
        <div className="max-h-56 overflow-y-auto rounded-md border border-border/60 px-2.5 py-1.5">
          <Markdown text={plan.body} />
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            className="min-h-11 sm:min-h-0"
            onClick={() => onIntent({ kind: "plan", planId: plan.planId, action: "approve", note: "" })}
            size="sm"
          >
            <Check aria-hidden="true" />
            Approve and start
          </Button>
          <Button className="min-h-11 sm:min-h-0" onClick={onRevise} size="sm" variant="outline">
            Revise
          </Button>
          <Button
            className="min-h-11 sm:min-h-0"
            onClick={() => onIntent({ kind: "plan", planId: plan.planId, action: "reject", note: "" })}
            size="sm"
            variant="ghost"
          >
            Reject
          </Button>
        </div>
      </div>
    </PanelChrome>
  );
}

// ---------------------------------------------------------------------------
// Turn error
// ---------------------------------------------------------------------------

export function TurnErrorBanner({
  error,
  onRetry,
}: {
  readonly error: Extract<TranscriptNotice, { kind: "error" }>;
  readonly onRetry: (() => void) | null;
}) {
  return (
    <div
      aria-label="Turn error"
      className="flex items-start gap-2 rounded-xl border border-destructive/32 bg-destructive/4 px-3 py-2.5 dark:bg-destructive/8"
      role="alert"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
      <p className="min-w-0 flex-1 text-destructive-foreground text-sm">{error.message}</p>
      {onRetry !== null && error.retryable && (
        <Button className="min-h-11 sm:min-h-0" onClick={onRetry} size="xs" variant="outline">
          <RotateCcw aria-hidden="true" />
          Retry
        </Button>
      )}
    </div>
  );
}

/** The whole attention stack, animated so panels slide in without jumping. */
export function AttentionStack({ children }: { readonly children: React.ReactNode }) {
  return (
    <AnimatedHeight>
      <div className="space-y-2">{children}</div>
    </AnimatedHeight>
  );
}
