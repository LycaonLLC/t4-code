// The composer: draft entry, slash commands, attachments, model/thinking/
// fast/mode controls, context meter, and the send/steer/stop affordance.
// Draft text continuity rides the shared workspace store (per-session,
// restored on A→B→A); model/thinking/fast/mode truth comes from the
// runtime's `controls` snapshot — session state is the authority, control
// changes leave as intents, and the labels only ever show what the runtime
// reports. Prompts leave through `submitPrompt` and settle on the runtime's
// outcome — the draft clears only on acceptance; the rest exits via
// `onIntent`.
import { Button, cn, IconButton, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { ArrowUp, ListTodo, Paperclip, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PromptOutcome } from "../session-runtime/controller.ts";
import type { PromptAttachment, SessionIntent } from "../session-runtime/intents.ts";
import {
  thinkingLabel,
  type ComposerControlsSnapshot,
} from "../session-runtime/session-controls.ts";
import { useWorkspace, workspaceStore } from "../../state/store-instance.ts";
import { selectSessionView } from "../../state/workspace-store.ts";
import { admitAttachments, type AttachmentCandidate } from "./attachments.ts";
import { composerStore, useComposer } from "./composer-store.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { AttachmentChips, RunOptionsMenu } from "./ComposerControls.tsx";
import { RuntimeOptions } from "./ComposerRuntimeOptions.tsx";
import { MobileComposerActions } from "./MobileComposerActions.tsx";
import { resolveComposerKey, resolveMenuKey } from "./keys.ts";
import {
  activeSlashQuery,
  buildSlashCatalog,
  searchSlashCommands,
  type SlashCommand,
} from "./slash.ts";
import {
  createSubmissionGate,
  type SubmissionIo,
  type SubmissionNotice,
  type SubmittedPrompt,
} from "./submission.ts";

const MAX_TEXTAREA_HEIGHT = 220;
const EMPTY_ATTACHMENTS: readonly PromptAttachment[] = [];

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ComposerProps {
  readonly sessionId: string;
  readonly link: "live" | "cached" | "offline";
  readonly turnActive: boolean;
  readonly canPrompt: boolean;
  /** Whether the running turn can be stopped right now. */
  readonly canCancel: boolean;
  /** Why stopping is unavailable; rendered on the disabled affordance. */
  readonly cancelDisabledReason: string | null;
  /**
   * Runtime-advertised slash commands (desktop). Null means the runtime has
   * no catalog of its own and the built-in browser catalog applies.
   */
  readonly slashCommands: readonly SlashCommand[] | null;
  readonly contextUsedTokens: number;
  readonly contextWindowTokens: number;
  readonly queuedFollowUps: readonly string[];
  /** Model / thinking / fast / mode truth from the session runtime. */
  readonly controls: ComposerControlsSnapshot;
  /** Non-null while the user is writing a plan revision note. */
  readonly revisingPlanId: string | null;
  readonly onCancelRevise: () => void;
  /** Submit a prompt-shaped intent and learn its fate. */
  readonly submitPrompt: (intent: SessionIntent) => Promise<PromptOutcome>;
  readonly onIntent: (intent: SessionIntent) => void;
}

export function Composer({
  sessionId,
  link,
  turnActive,
  canPrompt,
  canCancel,
  cancelDisabledReason,
  slashCommands,
  contextUsedTokens,
  contextWindowTokens,
  queuedFollowUps,
  controls,
  revisingPlanId,
  onCancelRevise,
  submitPrompt,
  onIntent,
}: ComposerProps) {
  const draft = useWorkspace((state) => selectSessionView(state, sessionId).draft);
  // Select primitives/stable references only — a fresh object per selector
  // call would loop useSyncExternalStore (React max-update-depth error 185).
  const attachments = useComposer(
    (state) => state.attachmentsBySessionId[sessionId] ?? EMPTY_ATTACHMENTS,
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [rejections, setRejections] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<SubmissionNotice>(null);
  const [sending, setSending] = useState(false);

  const disabled = !canPrompt;
  const disabledReason =
    link === "cached"
      ? "This is the last synced copy. Writing resumes when the connection returns."
      : link === "offline"
        ? "The host is unreachable. Your transcript stays readable; input returns with the host."
        : null;

  // Slash menu state derives from the draft + caret.
  const slashQuery = disabled ? null : activeSlashQuery(draft, caret);
  const catalog = useMemo(
    () => slashCommands ?? buildSlashCatalog({ link, turnActive }),
    [slashCommands, link, turnActive],
  );
  const slashItems = useMemo(
    () => (slashQuery === null ? [] : searchSlashCommands(catalog, slashQuery)),
    [catalog, slashQuery],
  );
  const menuOpen = slashQuery !== null && slashItems.length > 0 && !menuDismissed;

  useEffect(() => setMenuIndex(0), [slashQuery]);
  useEffect(() => {
    if (slashQuery === null) setMenuDismissed(false);
  }, [slashQuery]);

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, []);

  // Restore draft height on session switch; focus the field for live sessions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rerun on session switch
  useEffect(() => {
    resizeTextarea();
    if (!disabled) textareaRef.current?.focus();
  }, [sessionId, disabled, resizeTextarea]);

  const setDraft = useCallback(
    (value: string) => {
      workspaceStore.getState().setSessionDraft(sessionId, value);
    },
    [sessionId],
  );

  const acceptSlash = useCallback(
    (index: number) => {
      const item = slashItems[index];
      if (item === undefined || item.disabledReason !== null) return;
      setDraft(item.insert);
      setMenuDismissed(false);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (element !== null) {
          element.focus();
          element.setSelectionRange(item.insert.length, item.insert.length);
          setCaret(item.insert.length);
        }
      });
    },
    [slashItems, setDraft],
  );

  // One submission gate per runtime seam: it drops double-submits while a
  // send is pending and applies the outcome — clear on accepted, keep the
  // exact draft/attachments/caret on rejected or unknown.
  const gate = useMemo(() => createSubmissionGate(submitPrompt), [submitPrompt]);

  const submissionIo = useMemo<SubmissionIo>(
    () => ({
      getDraft: () => selectSessionView(workspaceStore.getState(), sessionId).draft,
      clearDraft: () => {
        workspaceStore.getState().setSessionDraft(sessionId, "");
        setRejections([]);
        requestAnimationFrame(resizeTextarea);
      },
      removeAttachments: (ids) => {
        for (const id of ids) composerStore.getState().removeAttachment(sessionId, id);
      },
      setNotice,
    }),
    [sessionId, resizeTextarea],
  );

  const runSubmission = useCallback(
    (intent: SessionIntent, submitted: SubmittedPrompt, onAccepted?: () => void) => {
      if (gate.pending()) return;
      setSending(true);
      void gate.submit(intent, submitted, submissionIo).then((outcome) => {
        setSending(false);
        if (outcome !== null && outcome.kind === "accepted") onAccepted?.();
      });
    },
    [gate, submissionIo],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (text === "" && attachments.length === 0) return;
    if (revisingPlanId !== null) {
      // The revision banner stays until the host accepts the note, so a
      // rejected revision keeps both the draft and the revising context.
      runSubmission(
        { kind: "plan", planId: revisingPlanId, action: "revise", note: text },
        { text: draft, attachmentIds: [] },
        onCancelRevise,
      );
      return;
    }
    if (turnActive) {
      runSubmission({ kind: "steer", text }, { text: draft, attachmentIds: [] });
      return;
    }
    runSubmission(
      { kind: "prompt", text, attachments },
      { text: draft, attachmentIds: attachments.map((attachment) => attachment.id) },
    );
  }, [draft, attachments, turnActive, revisingPlanId, onCancelRevise, runSubmission]);

  const queueFollowUp = useCallback(() => {
    const text = draft.trim();
    if (text === "") return;
    runSubmission({ kind: "followUp", text }, { text: draft, attachmentIds: [] });
  }, [draft, runSubmission]);

  const intake = useCallback(
    (candidates: readonly AttachmentCandidate[]) => {
      if (!controls.attachmentsSupported) return;
      const result = admitAttachments(attachments, candidates);
      if (result.accepted.length > 0) {
        composerStore.getState().addAttachments(sessionId, result.accepted);
      }
      setRejections(result.rejections);
    },
    [attachments, sessionId, controls.attachmentsSupported],
  );

  const filesToCandidates = (files: ArrayLike<File>): AttachmentCandidate[] =>
    Array.from(files, (file) => ({
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }));

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const keyInput = {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    };
    if (menuOpen) {
      const menuAction = resolveMenuKey(keyInput);
      if (menuAction === "next") {
        event.preventDefault();
        setMenuIndex((index) => Math.min(index + 1, slashItems.length - 1));
        return;
      }
      if (menuAction === "previous") {
        event.preventDefault();
        setMenuIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (menuAction === "accept") {
        const item = slashItems[menuIndex];
        if (item !== undefined && item.disabledReason === null) {
          event.preventDefault();
          acceptSlash(menuIndex);
          return;
        }
      }
      if (menuAction === "dismiss") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Escape" && revisingPlanId !== null) {
      event.preventDefault();
      onCancelRevise();
      return;
    }
    const action = resolveComposerKey(keyInput);
    if (action === "submit") {
      event.preventDefault();
      submit();
    }
    // "newline" falls through to the textarea's default behavior.
  };

  const primaryLabel = revisingPlanId !== null ? "Send revision" : turnActive ? "Steer" : "Send";
  const canSubmit = !disabled && (draft.trim() !== "" || attachments.length > 0);
  const runOptionsSummary = `${controls.modelLabel ?? "Host model"} · ${thinkingLabel(controls.thinking)}`;

  return (
    <div className="pointer-events-auto min-w-0 max-w-full">
      {queuedFollowUps.length > 0 && (
        <ul aria-label="Queued follow-ups" className="mb-2 flex flex-wrap gap-1.5">
          {queuedFollowUps.map((text, index) => (
            <li
              className="flex h-6 max-w-72 items-center gap-1.5 rounded-md border border-input bg-popover px-2 text-xs"
              // biome-ignore lint/suspicious/noArrayIndexKey: queue is append-only in order
              key={index}
            >
              <ListTodo aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate text-muted-foreground">{text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        {menuOpen && (
          <div className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-(--overlay-shadow)">
            <ul aria-label="Commands" className="max-h-64 overflow-y-auto p-1" role="listbox">
              {slashItems.map((item, index) => {
                const isDisabled = item.disabledReason !== null;
                return (
                  <li
                    aria-disabled={isDisabled || undefined}
                    aria-selected={index === menuIndex}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 sm:min-h-0",
                      index === menuIndex && "bg-secondary",
                      isDisabled && "cursor-default opacity-64",
                    )}
                    key={item.name}
                    onClick={() => acceptSlash(index)}
                    onMouseMove={() => setMenuIndex(index)}
                    role="option"
                  >
                    <span className="font-mono text-sm">{item.name}</span>
                    {item.argsHint !== "" && (
                      <span className="font-mono text-muted-foreground text-xs">
                        {item.argsHint}
                      </span>
                    )}
                    {item.aliases.length > 0 && (
                      <span className="font-mono text-muted-foreground text-xs">
                        {item.aliases.join(" ")}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-right text-muted-foreground text-xs">
                      {item.disabledReason ?? item.description}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div
          className="min-w-0 max-w-full rounded-xl border border-input bg-(--composer-background) shadow-(--composer-shadow) backdrop-blur-(--composer-blur)"
          onDragOver={(event) => {
            if (
              !disabled &&
              controls.attachmentsSupported &&
              event.dataTransfer.types.includes("Files")
            ) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            if (disabled || !controls.attachmentsSupported) return;
            event.preventDefault();
            intake(filesToCandidates(event.dataTransfer.files));
          }}
        >
          {revisingPlanId !== null && (
            <div className="flex items-center gap-2 px-3 pt-2.5">
              <span className="flex h-6 items-center gap-1.5 rounded-md bg-status-plan-dot/12 px-2 font-medium text-status-plan text-xs">
                Revising the plan
              </span>
              <button
                className="min-h-11 cursor-pointer px-2 text-muted-foreground text-xs underline-offset-2 transition-colors duration-(--motion-duration-fast) hover:text-foreground hover:underline sm:min-h-0 sm:px-0"
                onClick={onCancelRevise}
                type="button"
              >
                Cancel
              </button>
            </div>
          )}
          <AttachmentChips
            attachments={attachments}
            onRemove={(id) => composerStore.getState().removeAttachment(sessionId, id)}
          />
          <textarea
            aria-label={
              revisingPlanId !== null
                ? "Describe how the plan should change"
                : "Message the session"
            }
            className="max-h-55 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-64"
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              if (disabled || event.clipboardData.files.length === 0) return;
              event.preventDefault();
              intake(filesToCandidates(event.clipboardData.files));
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            placeholder={
              disabled
                ? "Read-only right now"
                : revisingPlanId !== null
                  ? "What should change in the plan?"
                  : turnActive
                    ? "Steer the running turn, or queue a follow-up"
                    : "Message, or / for commands"
            }
            ref={textareaRef}
            rows={1}
            value={draft}
          />
          {controls.attachmentsSupported && (
            <input
              accept="image/png,image/jpeg,image/webp,image/gif,text/*,application/json"
              className="hidden"
              multiple
              onChange={(event) => {
                if (event.target.files !== null) intake(filesToCandidates(event.target.files));
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
          )}
          <div className="hidden min-w-0 items-center gap-0.5 px-2 pb-2 sm:flex">
            <RuntimeOptions
              compact={false}
              controls={controls}
              disabled={disabled}
              onIntent={onIntent}
            />
            <span className="min-w-0 flex-1" />
            {controls.attachmentsSupported && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <IconButton
                      aria-label="Attach files"
                      disabled={disabled}
                      onClick={() => fileInputRef.current?.click()}
                      size="icon-sm"
                    >
                      <Paperclip />
                    </IconButton>
                  }
                />
                <TooltipPopup side="top">Attach images or text files</TooltipPopup>
              </Tooltip>
            )}
            <ContextMeter usedTokens={contextUsedTokens} windowTokens={contextWindowTokens} />
            {turnActive && (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <IconButton
                        aria-disabled={!canCancel || undefined}
                        aria-label="Stop the running turn"
                        className={cn(!canCancel && "opacity-64")}
                        onClick={() => {
                          // A disabled stop never sends session.cancel — the
                          // reason renders instead of a dead command.
                          if (canCancel) onIntent({ kind: "cancel" });
                        }}
                        size="icon-sm"
                      >
                        <Square />
                      </IconButton>
                    }
                  />
                  <TooltipPopup side="top">
                    {canCancel ? "Stop" : (cancelDisabledReason ?? "Stop is unavailable right now")}
                  </TooltipPopup>
                </Tooltip>
                <Button
                  disabled={disabled || sending || draft.trim() === ""}
                  onClick={queueFollowUp}
                  size="xs"
                  variant="outline"
                >
                  Queue
                </Button>
              </>
            )}
            <Button
              aria-busy={sending || undefined}
              aria-label={primaryLabel}
              className="ml-1"
              disabled={!canSubmit || sending}
              onClick={submit}
              size="xs"
            >
              <ArrowUp aria-hidden="true" />
              {primaryLabel}
            </Button>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 px-2 pb-2 sm:hidden">
            <div className="flex min-w-0 items-center gap-1">
              <RunOptionsMenu summary={runOptionsSummary}>
                <RuntimeOptions
                  compact
                  controls={controls}
                  disabled={disabled}
                  onIntent={onIntent}
                />
              </RunOptionsMenu>
              <span className="min-w-0 flex-1" />
              {controls.attachmentsSupported && (
                <IconButton
                  aria-label="Attach files"
                  disabled={disabled}
                  onClick={() => fileInputRef.current?.click()}
                  size="icon-xl"
                >
                  <Paperclip />
                </IconButton>
              )}
              <ContextMeter usedTokens={contextUsedTokens} windowTokens={contextWindowTokens} />
            </div>
            <MobileComposerActions
              canCancel={canCancel}
              cancelDisabledReason={cancelDisabledReason}
              onCancel={() => onIntent({ kind: "cancel" })}
              onQueue={queueFollowUp}
              onSubmit={submit}
              primaryBusy={sending}
              primaryDisabled={!canSubmit || sending}
              primaryLabel={primaryLabel}
              queueDisabled={disabled || sending || draft.trim() === ""}
              turnActive={turnActive}
            />
          </div>
        </div>
      </div>
      <div aria-live="polite" className="min-h-0">
        {rejections.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 px-1">
            {rejections.map((reason) => (
              <li className="text-warning-foreground text-xs" key={reason}>
                {reason}
              </li>
            ))}
          </ul>
        )}
        {notice !== null && (
          <p className="mt-1.5 px-1 text-warning-foreground text-xs" role="status">
            {notice.message}
          </p>
        )}
        {controls.controlError !== null && (
          <p className="mt-1.5 px-1 text-warning-foreground text-xs" role="status">
            {controls.controlError}
          </p>
        )}
        {disabledReason !== null && (
          <p className="mt-1.5 px-1 text-muted-foreground text-xs">{disabledReason}</p>
        )}
      </div>
    </div>
  );
}
