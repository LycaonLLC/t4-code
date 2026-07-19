import { Badge, Button, cn } from "@t4-code/ui";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  LockKeyhole,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { WorkspaceProject, WorkspaceSession } from "../../lib/workspace-data.ts";

const SAMPLE_PREVIEW_URL = "https://preview.example.test/reconnect";
const SAMPLE_NAVIGATION_ACTIONS: readonly {
  readonly label: string;
  readonly Icon: LucideIcon;
}[] = [
  { label: "Back", Icon: ChevronLeft },
  { label: "Forward", Icon: ChevronRight },
  { label: "Reload", Icon: RotateCw },
];

export function FixturePreviewWorkspace({
  session,
  project,
}: {
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
}) {
  const navigate = useNavigate();
  const [scale, setScale] = useState<"fit" | "actual">("fit");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="surface-subheader flex min-h-14 shrink-0 items-center gap-2 px-3">
        <Button
          aria-label="Back to session"
          onClick={() =>
            void navigate({ params: { sessionId: session.id }, to: "/sessions/$sessionId" })
          }
          size="sm"
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" />
          Session
        </Button>
        <span aria-hidden="true" className="h-5 w-px bg-border" />
        <span className="min-w-0">
          <h1 className="truncate font-medium text-sm">Browser preview</h1>
          <p className="truncate text-muted-foreground text-xs">{project.name}</p>
        </span>
        <span className="flex-1" />
        <Badge variant="outline">Sample data</Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          <section
            aria-label="Preview controls"
            className="rounded-xl border border-border bg-card p-3"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label
                className="min-w-0 flex-1 text-muted-foreground text-xs"
                htmlFor="fixture-preview-url"
              >
                URL
                <input
                  className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground outline-none sm:min-h-8"
                  id="fixture-preview-url"
                  readOnly
                  value={SAMPLE_PREVIEW_URL}
                />
              </label>
              <div aria-label="Sample preview navigation" className="flex gap-1" role="group">
                {SAMPLE_NAVIGATION_ACTIONS.map(({ label, Icon }) => (
                  <Button
                    disabled
                    key={label}
                    size="icon-sm"
                    title="Disabled in sample data"
                    variant="outline"
                  >
                    <Icon aria-hidden="true" />
                    <span className="sr-only">{label}</span>
                  </Button>
                ))}
              </div>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-muted-foreground text-xs">
              <LockKeyhole aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
              This deterministic preview is rendered locally. It opens no browser, sends no input,
              and uses no account or network connection.
            </p>
          </section>

          <section
            aria-label="Sample browser snapshot"
            className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
          >
            <div className="flex min-h-10 items-center gap-2 border-border border-b bg-secondary/50 px-3">
              <span className="font-medium text-sm">Snapshot</span>
              <Badge variant="secondary">Read-only fixture</Badge>
              <span className="flex-1" />
              <button
                aria-pressed={scale === "fit"}
                className="min-h-9 rounded-md px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setScale("fit")}
                type="button"
              >
                Fit
              </button>
              <button
                aria-pressed={scale === "actual"}
                className="min-h-9 rounded-md px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setScale("actual")}
                type="button"
              >
                Actual
              </button>
            </div>
            <div
              className={cn(
                "overflow-auto bg-muted/40 p-3 sm:p-6",
                scale === "actual" && "max-h-[62vh]",
              )}
            >
              <article
                className={cn(
                  "mx-auto overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl",
                  scale === "fit" ? "w-full max-w-4xl" : "w-[920px]",
                )}
              >
                <header className="flex items-center gap-3 border-border border-b px-4 py-3">
                  <div className="grid size-8 place-items-center rounded-md bg-primary font-bold text-primary-foreground">
                    T4
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold text-sm">Reconnect diagnostics</h2>
                    <p className="truncate text-muted-foreground text-xs">
                      Fixture dashboard · captured 9:12 AM
                    </p>
                  </div>
                  <span className="ml-auto rounded-full bg-success/15 px-2 py-1 font-medium text-success text-xs">
                    Healthy
                  </span>
                </header>
                <div className="grid gap-3 p-4 sm:grid-cols-3">
                  {[
                    ["Active sessions", "12", "All replay cursors current"],
                    ["Buffered frames", "0", "No duplicate sequence IDs"],
                    ["Reconnect p95", "184 ms", "Within the 250 ms target"],
                  ].map(([label, value, detail]) => (
                    <section className="rounded-lg border border-border p-3" key={label}>
                      <p className="text-muted-foreground text-xs">{label}</p>
                      <p className="mt-1 font-semibold text-2xl tracking-tight">{value}</p>
                      <p className="mt-2 text-muted-foreground text-xs">{detail}</p>
                    </section>
                  ))}
                </div>
                <div className="mx-4 mb-4 overflow-hidden rounded-lg border border-border">
                  <div className="grid grid-cols-[1fr_auto] bg-muted/50 px-3 py-2 font-medium text-muted-foreground text-xs">
                    <span>Recent reconnect</span>
                    <span>Result</span>
                  </div>
                  {[
                    ["dev-server · epoch 8", "Recovered"],
                    ["This machine · epoch 21", "No gap"],
                    ["test-runner · epoch 5", "Recovered"],
                  ].map(([name, result]) => (
                    <div
                      className="grid grid-cols-[1fr_auto] border-border border-t px-3 py-2 text-xs"
                      key={name}
                    >
                      <span>{name}</span>
                      <span className="font-medium text-success">{result}</span>
                    </div>
                  ))}
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
