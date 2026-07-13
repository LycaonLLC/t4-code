import { Button, cn } from "@t4-code/ui";
import { ArrowUp, Square } from "lucide-react";
import { useId } from "react";

export interface MobileComposerActionsProps {
  readonly turnActive: boolean;
  readonly canCancel: boolean;
  readonly cancelDisabledReason: string | null;
  readonly queueDisabled: boolean;
  readonly primaryDisabled: boolean;
  readonly primaryBusy: boolean;
  readonly primaryLabel: string;
  readonly onCancel: () => void;
  readonly onQueue: () => void;
  readonly onSubmit: () => void;
}

/**
 * Phone-only primary action row. Every action remains in the fixed composer
 * footprint instead of competing with model controls for horizontal space.
 */
export function MobileComposerActions({
  turnActive,
  canCancel,
  cancelDisabledReason,
  queueDisabled,
  primaryDisabled,
  primaryBusy,
  primaryLabel,
  onCancel,
  onQueue,
  onSubmit,
}: MobileComposerActionsProps) {
  const stopReasonId = useId();
  const stopReason = cancelDisabledReason ?? "Stop is unavailable right now";

  return (
    <>
      <div
        aria-label={turnActive ? "Turn controls" : "Message actions"}
        className={cn(
          "grid min-w-0 gap-1.5",
          turnActive
            ? "grid-cols-[minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.4fr)]"
            : "grid-cols-1",
        )}
        role="group"
      >
        {turnActive && (
          <Button
            aria-describedby={!canCancel ? stopReasonId : undefined}
            aria-disabled={!canCancel || undefined}
            className={cn("min-h-11 min-w-0", !canCancel && "opacity-64")}
            onClick={() => {
              if (canCancel) onCancel();
            }}
            size="default"
            variant="outline"
          >
            <Square aria-hidden="true" />
            Stop
          </Button>
        )}
        {turnActive && (
          <Button
            className="min-h-11 min-w-0"
            disabled={queueDisabled}
            onClick={onQueue}
            size="default"
            variant="outline"
          >
            Queue
          </Button>
        )}
        <Button
          aria-busy={primaryBusy || undefined}
          aria-label={primaryLabel}
          className="min-h-11 min-w-0"
          disabled={primaryDisabled}
          onClick={onSubmit}
          size="default"
        >
          <ArrowUp aria-hidden="true" />
          {primaryLabel}
        </Button>
      </div>
      {!canCancel && turnActive && (
        <span className="sr-only" id={stopReasonId}>
          {stopReason}
        </span>
      )}
    </>
  );
}
