// Context usage meter: a small ring in the composer controls that opens a
// popover breakdown on demand (never a tab, never a dashboard). Pattern from
// T3 Code apps/web/src/components/chat/ContextWindowMeter.tsx (MIT, T3 Tools
// Inc., commit f61fa9499d96fee825492aba204593c37b27e0cb), rebuilt on OMP
// tokens with an SVG ring and plain-language copy.
import { Popover } from "@base-ui/react/popover";
import { cn } from "@t4-code/ui";

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ContextMeterProps {
  readonly usedTokens: number;
  readonly windowTokens: number;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

export function ContextMeter({ usedTokens, windowTokens }: ContextMeterProps) {
  const fraction = windowTokens > 0 ? Math.min(1, usedTokens / windowTokens) : 0;
  const percent = Math.round(fraction * 100);
  const nearFull = fraction >= 0.85;
  const remaining = Math.max(0, windowTokens - usedTokens);
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Context ${percent}% full`}
        className="flex h-11 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:px-1.5"
      >
        <svg aria-hidden="true" className="size-4 shrink-0" viewBox="0 0 16 16">
          <circle
            className="stroke-input"
            cx="8"
            cy="8"
            fill="none"
            r={RING_RADIUS}
            strokeWidth="2"
          />
          <circle
            className={cn("stroke-current", nearFull && "text-warning-foreground")}
            cx="8"
            cy="8"
            fill="none"
            r={RING_RADIUS}
            strokeDasharray={`${fraction * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            strokeLinecap="round"
            strokeWidth="2"
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span className="tabular-nums">{percent}%</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" side="top" sideOffset={8}>
          <Popover.Popup className="w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-(--overlay-shadow) outline-none transition-[scale,opacity] duration-(--motion-duration-fast) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Popover.Title className="font-medium text-sm">Context window</Popover.Title>
            <dl className="mt-2 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">In use</dt>
                <dd className="font-mono tabular-nums">{formatTokens(usedTokens)} tokens</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Free</dt>
                <dd className="font-mono tabular-nums">{formatTokens(remaining)} tokens</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Window</dt>
                <dd className="font-mono tabular-nums">{formatTokens(windowTokens)} tokens</dd>
              </div>
            </dl>
            <div
              aria-hidden="true"
              className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-(--status-working-dot) transition-[width] duration-(--motion-duration-slow)",
                  nearFull && "bg-warning",
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              {nearFull
                ? "Almost full. Older context gets compacted soon; /compact folds it now."
                : "Fills as the conversation grows. /compact folds older context early."}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
