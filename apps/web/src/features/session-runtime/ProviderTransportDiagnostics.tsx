import type { ProviderTransportState } from "@t4-code/protocol";
import { Button, cn } from "@t4-code/ui";
import { Activity, Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  buildProviderTransportReport,
  presentProviderTransport,
} from "./provider-transport.ts";

function DiagnosticValue({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">{label}</dt>
      <dd className="mt-1 truncate font-mono text-foreground text-xs">{value}</dd>
    </div>
  );
}

export function ProviderTransportDiagnostics({
  onOpenHostHealth,
  state,
}: {
  readonly onOpenHostHealth: () => void;
  readonly state: ProviderTransportState;
}) {
  const view = presentProviderTransport(state);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current !== null) clearTimeout(resetRef.current);
    },
    [],
  );
  const copyReport = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildProviderTransportReport(state));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetRef.current !== null) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setCopyState("idle"), 2_000);
  };
  return (
    <details
      className="group shrink-0 border-border/60 border-b bg-background/80 text-xs open:bg-secondary/50"
      data-provider-transport={state.lastTransport ?? "waiting"}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-muted-foreground outline-none transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            view.tone === "good" && "bg-status-done-dot",
            view.tone === "warn" && "bg-status-approval-dot",
            view.tone === "quiet" && "bg-muted-foreground/50",
          )}
        />
        <span className="font-medium text-foreground">Codex transport</span>
        <span className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground uppercase tracking-wide">
          {view.transport}
        </span>
        <span className="truncate">{view.status}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px]">
          Details
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 transition-transform group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="border-border/60 border-t px-4 py-3">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DiagnosticValue label="Actual transport" value={view.transport} />
          <DiagnosticValue label="Configured policy" value={view.policy} />
          <DiagnosticValue label="Context requests" value={view.reuse} />
          <DiagnosticValue label="Input JSON" value={view.payload} />
        </dl>
        <div className="mt-3 flex flex-col gap-2 border-border/60 border-t pt-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{view.connection}</span>
            <span aria-hidden="true">·</span>
            <span>{state.canAppend ? "Incremental context available" : "Full context required"}</span>
            <span aria-hidden="true">·</span>
            <span>Redacted by OMP</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Transport recovery actions">
            <Button onClick={onOpenHostHealth} size="sm" variant="ghost">
              <Activity aria-hidden="true" />
              Host health
            </Button>
            <Button onClick={() => void copyReport()} size="sm" variant="outline">
              {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy report"}
            </Button>
            <span aria-live="polite" className="sr-only">
              {copyState === "copied"
                ? "Redacted transport report copied"
                : copyState === "failed"
                  ? "Could not copy the transport report"
                  : ""}
            </span>
          </div>
        </div>
      </div>
    </details>
  );
}
