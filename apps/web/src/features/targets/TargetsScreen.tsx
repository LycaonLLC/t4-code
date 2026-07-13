// The hosts screen: the local runtime service card, every configured
// target with its real connection state, pairing when the host asks for it,
// and the add-host form. Every state shown here comes from the desktop
// runtime snapshot or a completed desktop call — connection words are the
// runtime's words, and removing a host says exactly what it does: it
// deletes the credential stored on this computer, nothing more.
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import type { ServiceInspection } from "@t4-code/protocol/desktop-ipc";
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  IconButton,
  Spinner,
} from "@t4-code/ui";
import { ArrowLeft, Cable, Check, Copy, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ToneBadge } from "../onboarding/bits.tsx";
import { FIELD_CLASS } from "../settings/controls.tsx";
import {
  capabilityDiff,
  CONNECTION_STATE_META,
  deriveTargetRows,
  pairCommandForTarget,
  TARGET_CAPABILITY_GROUPS,
  type TargetCapabilityGroupId,
  type TargetRow,
} from "./model.ts";
import { useTargets, type ServiceActionId, type TargetsStoreApi } from "./targets-store.ts";

// ─── Local service card ─────────────────────────────────────────────────────

interface ServiceStatusCopy {
  readonly label: string;
  readonly tone: "success" | "working" | "error" | "muted";
}

const SERVICE_STATUS_COPY: Record<ServiceInspection["service"], ServiceStatusCopy> = {
  running: { label: "Running", tone: "success" },
  starting: { label: "Starting", tone: "working" },
  stopped: { label: "Stopped", tone: "muted" },
  failed: { label: "Failed", tone: "error" },
  unknown: { label: "Unknown", tone: "muted" },
};

function ServiceCard({ api }: { readonly api: TargetsStoreApi }) {
  const service = useTargets(api, (state) => state.service);
  const inspection = service.inspection;
  const busy = service.pending !== null;
  const status: ServiceStatusCopy | null = inspection === null
    ? null
    : inspection.issue?.code === "omp_incompatible"
      ? { label: "OMP update required", tone: "error" }
      : inspection.issue?.code === "omp_not_found"
        ? { label: "OMP not found", tone: "error" }
        : inspection.issue?.code === "service_unavailable"
          ? { label: "Service unavailable", tone: "error" }
          : SERVICE_STATUS_COPY[inspection.service];

  const actions: readonly { readonly id: ServiceActionId; readonly label: string; readonly show: boolean }[] =
    inspection === null || inspection.issue !== undefined
      ? []
      : [
          { id: "install", label: inspection.definition === "drifted" ? "Repair the service" : "Install the service", show: inspection.definition !== "current" },
          { id: "start", label: "Start", show: inspection.definition === "current" && (inspection.service === "stopped" || inspection.service === "failed") },
          { id: "restart", label: "Restart", show: inspection.definition === "current" && inspection.service === "running" },
          { id: "stop", label: "Stop", show: inspection.definition === "current" && (inspection.service === "running" || inspection.service === "starting") },
        ];

  return (
    <section aria-labelledby="local-service-heading" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium text-sm" id="local-service-heading">
          Local OMP runtime
        </h2>
        {service.pending !== null ? (
          <ToneBadge label={service.pending === "inspect" ? "Checking" : "Working"} live tone="working" />
        ) : status !== null ? (
          <ToneBadge label={status.label} tone={status.tone} />
        ) : (
          <ToneBadge label="Not checked yet" tone="muted" />
        )}
      </div>
      {inspection !== null && (
        <p className="text-muted-foreground text-xs">
          {inspection.issue !== undefined
            ? inspection.issue.message
            : inspection.definition === "missing"
            ? "No service is installed for the local runtime yet."
            : inspection.definition === "drifted"
              ? "The installed service definition is out of date."
              : inspection.service === "running"
                ? "The local runtime is installed and running."
                : "The local runtime is installed."}
        </p>
      )}
      {inspection !== null && inspection.diagnostics.length > 0 && (
        <p className="rounded-md bg-secondary px-2.5 py-1.5 font-mono text-muted-foreground text-xs">{inspection.diagnostics}</p>
      )}
      {service.error !== null && (
        <p className="text-destructive-foreground text-xs" role="alert">
          {service.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {actions
          .filter((action) => action.show)
          .map((action) => (
            <Button
              disabled={busy}
              key={action.id}
              onClick={() => void api.getState().runServiceAction(action.id)}
              size="xs"
              variant={action.id === "stop" ? "ghost" : "outline"}
            >
              {service.pending === action.id && <Spinner />}
              {action.label}
            </Button>
          ))}
        <Button disabled={busy} onClick={() => void api.getState().inspectService()} size="xs" variant="ghost">
          Check again
        </Button>
      </div>
    </section>
  );
}

// ─── Target rows ────────────────────────────────────────────────────────────

function CapabilityGrantSummary({
  requested,
  granted,
}: {
  readonly requested: readonly string[] | undefined;
  readonly granted: readonly string[] | null;
}) {
  if (granted === null) return null;
  if (requested === undefined) {
    return (
      <p className="text-muted-foreground text-xs">
        The host granted: <span className="font-mono">{granted.length === 0 ? "nothing" : granted.join(", ")}</span>
      </p>
    );
  }
  const diff = capabilityDiff(requested, granted);
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <p className="text-muted-foreground">
        Granted {diff.granted.length} of {requested.length} requested permissions.
      </p>
      {diff.missing.length > 0 && (
        <p className="text-warning-foreground">
          Not granted: <span className="font-mono">{diff.missing.join(", ")}</span>
        </p>
      )}
      {diff.extra.length > 0 && (
        <p className="text-muted-foreground">
          Also granted: <span className="font-mono">{diff.extra.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

export function PairForm({
  api,
  targetId,
  requested,
}: {
  readonly api: TargetsStoreApi;
  readonly targetId: string;
  readonly requested: readonly string[] | undefined;
}) {
  const code = useTargets(api, (state) => state.pairCodes[targetId] ?? "");
  const error = useTargets(api, (state) => state.pairErrors[targetId]);
  const busy = useTargets(api, (state) => state.busy[targetId] === "pair");
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyResetRef.current), []);
  const inputId = `pair-code-${targetId}`;
  // Built entirely from code-owned catalog constants — no address, label,
  // token, or code ever enters this string.
  const pair = pairCommandForTarget(requested);
  return (
    <form
      className="flex flex-col gap-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        void api.getState().submitPair(targetId);
      }}
    >
      <label className="font-medium text-sm" htmlFor={inputId}>
        Pairing code
      </label>
      <p className="text-muted-foreground text-xs">
        On that computer, run the command below and type the six-digit code it shows.
      </p>
      <div className="flex items-center gap-1.5">
        <input
          aria-describedby={error === undefined ? undefined : `${inputId}-error`}
          aria-invalid={error !== undefined}
          autoComplete="one-time-code"
          className={cn(FIELD_CLASS, "w-28 text-center font-mono tracking-[0.3em]", error !== undefined && "border-destructive")}
          id={inputId}
          inputMode="numeric"
          onChange={(event) => api.getState().setPairCode(targetId, event.target.value)}
          placeholder="000000"
          value={code}
        />
        <Button disabled={busy} size="sm" type="submit">
          {busy && <Spinner />}
          Pair
        </Button>
      </div>
      {error !== undefined && (
        <p className="text-destructive-foreground text-xs" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="flex items-start gap-1.5">
        <pre className="min-w-0 flex-1 select-all overflow-x-auto rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed">
          <code>{pair.command}</code>
        </pre>
        <IconButton
          aria-label="Copy pair command"
          onClick={() => {
            void navigator.clipboard.writeText(pair.command);
            setCopied(true);
            clearTimeout(copyResetRef.current);
            copyResetRef.current = setTimeout(() => setCopied(false), 1_500);
          }}
          size="icon-xs"
        >
          {copied ? <Check aria-hidden="true" className="text-success-foreground" /> : <Copy aria-hidden="true" />}
        </IconButton>
      </div>
      <p className="text-muted-foreground text-xs">
        {pair.observeFallback
          ? "No saved permission choice for this host, so this command asks for view-only access."
          : "This command grants only the controls you picked when adding this host."}
      </p>
      <p aria-live="polite" className="sr-only">
        {copied ? "Pair command copied to the clipboard." : ""}
      </p>
    </form>
  );
}

function TargetCard({ api, row }: { readonly api: TargetsStoreApi; readonly row: TargetRow }) {
  const busyAction = useTargets(api, (state) => state.busy[row.target.targetId]);
  const targetError = useTargets(api, (state) => state.targetErrors[row.target.targetId]);
  const requested = useTargets(api, (state) => state.requestedCapabilities[row.target.targetId]);
  const meta = CONNECTION_STATE_META[row.state];
  const busy = busyAction !== undefined;
  const remote = row.target.kind === "remote";

  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3"
      data-target-id={row.target.targetId}
      data-target-state={row.state}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{row.target.label}</span>
        {remote && row.target.mode !== undefined && (
          <Badge variant="outline">{row.target.mode === "serve" ? "Tailscale Serve" : "Direct"}</Badge>
        )}
        {!remote && <Badge variant="outline">This computer</Badge>}
        <ToneBadge label={meta.label} live={meta.live} tone={meta.tone} />
      </div>
      {remote && row.target.status === "revoked" && (
        <p className="text-warning-foreground text-xs">
          That host reported this device's access as revoked. Pair again to continue.
        </p>
      )}
      {row.state === "error" && row.lastError !== null && (
        <p className="text-destructive-foreground text-xs">{row.lastError}</p>
      )}
      {targetError !== undefined && (
        <p className="text-destructive-foreground text-xs" role="alert">
          {targetError}
        </p>
      )}
      {remote && <CapabilityGrantSummary granted={row.grantedCapabilities} requested={requested} />}
      {row.state === "pairing-required" && <PairForm api={api} requested={requested} targetId={row.target.targetId} />}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {(row.state === "disconnected" || row.state === "error") && (
          <Button
            disabled={busy}
            onClick={() => void api.getState().connect(row.target.targetId)}
            size="xs"
            variant="outline"
          >
            {busyAction === "connect" && <Spinner />}
            {row.state === "error" ? "Try again" : "Connect"}
          </Button>
        )}
        {(row.state === "connected" || row.state === "connecting" || row.state === "pairing-required") && (
          <Button
            disabled={busy}
            onClick={() => void api.getState().disconnect(row.target.targetId)}
            size="xs"
            variant="ghost"
          >
            {busyAction === "disconnect" && <Spinner />}
            Disconnect
          </Button>
        )}
        <span className="flex-1" />
        {remote && (
          <Button
            disabled={busy}
            onClick={() => api.getState().askRemove(row.target.targetId)}
            size="xs"
            variant="ghost"
          >
            Remove…
          </Button>
        )}
      </div>
    </li>
  );
}

// ─── Add-host form ──────────────────────────────────────────────────────────

function AddHostForm({ api }: { readonly api: TargetsStoreApi }) {
  const draft = useTargets(api, (state) => state.draft);
  const errors = useTargets(api, (state) => state.draftErrors);
  const addError = useTargets(api, (state) => state.addError);
  const adding = useTargets(api, (state) => state.adding);
  const setDraft = (next: Partial<typeof draft>) => api.getState().setDraft({ ...draft, ...next });

  const field = (
    name: "label" | "address" | "port" | "expectedHostId",
    label: string,
    props: { readonly placeholder?: string; readonly hint?: string },
  ) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs">{label}</span>
      <input
        aria-invalid={errors[name] !== undefined}
        className={cn(FIELD_CLASS, errors[name] !== undefined && "border-destructive")}
        onChange={(event) => setDraft({ [name]: event.target.value })}
        placeholder={props.placeholder}
        value={draft[name]}
      />
      {errors[name] !== undefined ? (
        <span className="text-destructive-foreground text-xs" role="alert">
          {errors[name]}
        </span>
      ) : (
        props.hint !== undefined && <span className="text-muted-foreground text-xs">{props.hint}</span>
      )}
    </label>
  );

  return (
    <form
      aria-labelledby="add-host-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void api.getState().submitAdd();
      }}
    >
      <h2 className="flex items-center gap-2 font-medium text-sm" id="add-host-heading">
        <Plus aria-hidden="true" className="size-4" />
        Add a computer over Tailscale
      </h2>
      <div aria-label="How to reach it" className="flex items-center gap-0.5 self-start rounded-lg border border-border p-0.5" role="group">
        {(["direct", "serve"] as const).map((mode) => (
          <button
            aria-pressed={draft.mode === mode}
            className={cn(
              "h-6.5 cursor-pointer rounded-md px-2 font-medium text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              draft.mode === mode ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            key={mode}
            onClick={() => setDraft({ mode })}
            type="button"
          >
            {mode === "direct" ? "Direct (tailnet)" : "Tailscale Serve (HTTPS)"}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("label", "Name", { placeholder: "Work desktop" })}
        {field(
          "address",
          draft.mode === "direct" ? "Tailscale IP or name" : "HTTPS address",
          draft.mode === "direct"
            ? { placeholder: "100.64.0.12 or host.tailnet.ts.net" }
            : { placeholder: "https://host.tailnet.ts.net" },
        )}
        {field("port", "Port", { hint: draft.mode === "serve" ? "Leave empty for 443." : "The port the host's runtime listens on." })}
        {field("expectedHostId", "Expected host ID (optional)", {
          hint: "If set, the connection is refused when a different host answers.",
        })}
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Ask that host for permission to
        </legend>
        {TARGET_CAPABILITY_GROUPS.map((group) => {
          const locked = group.id === "observe";
          const checked = locked || draft.groups.has(group.id);
          return (
            <label
              className={cn("flex items-start gap-2.5 rounded-md px-2 py-1.5", locked ? "opacity-72" : "cursor-pointer hover:bg-secondary/60")}
              key={group.id}
            >
              <input
                checked={checked}
                className="mt-0.5 size-4 accent-primary"
                disabled={locked}
                onChange={() => {
                  const groups = new Set<TargetCapabilityGroupId>(draft.groups);
                  if (groups.has(group.id)) groups.delete(group.id);
                  else groups.add(group.id);
                  groups.add("observe");
                  setDraft({ groups });
                }}
                type="checkbox"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-sm">{group.label}</span>
                <span className="text-muted-foreground text-xs">{group.impact}</span>
              </span>
            </label>
          );
        })}
        <p className="px-2 text-muted-foreground text-xs">
          The host decides what it actually grants when you pair. You'll see the difference here.
        </p>
      </fieldset>
      {addError !== null && (
        <p className="text-destructive-foreground text-xs" role="alert">
          {addError}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button disabled={adding} size="sm" type="submit">
          {adding && <Spinner />}
          Add and connect
        </Button>
        <Button onClick={() => api.getState().resetDraft()} size="sm" type="button" variant="ghost">
          Clear
        </Button>
      </div>
    </form>
  );
}

// ─── Remove confirmation ────────────────────────────────────────────────────

function RemoveDialog({ api, rows }: { readonly api: TargetsStoreApi; readonly rows: readonly TargetRow[] }) {
  const removing = useTargets(api, (state) => state.removing);
  const row = rows.find((entry) => entry.target.targetId === removing);
  const label = row?.target.label ?? "this host";
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : api.getState().cancelRemove())} open={removing !== null}>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Remove {label}?</DialogTitle>
          <DialogDescription>
            This forgets the connection and deletes the credential stored on this computer. It does not tell{" "}
            {label} anything — that host still lists this device as paired until you revoke it there (run{" "}
            <span className="font-mono">omp appserver devices</span> on that computer).
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="ghost" />}>Keep it</DialogClose>
          <Button onClick={() => void api.getState().confirmRemove()} size="sm" variant="destructive">
            Remove {label}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────

export function TargetsScreen({
  api,
  snapshot,
  serviceAvailable,
  onBack,
}: {
  readonly api: TargetsStoreApi;
  readonly snapshot: DesktopRuntimeSnapshot;
  /** Whether this desktop build exposes local service management. */
  readonly serviceAvailable: boolean;
  readonly onBack: () => void;
}) {
  const announcement = useTargets(api, (state) => state.announcement);
  const rows = deriveTargetRows(snapshot);

  // One initial service check per mount; later checks are user-driven.
  useEffect(() => {
    if (serviceAvailable) void api.getState().inspectService();
  }, [api, serviceAvailable]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-border border-b px-4 py-2">
        <IconButton aria-label="Back to settings" onClick={onBack} size="icon-sm">
          <ArrowLeft />
        </IconButton>
        <Cable aria-hidden="true" className="size-4 text-muted-foreground" />
        <h1 className="font-heading font-semibold text-base">Hosts</h1>
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-end text-muted-foreground text-xs" role="status">
          {announcement}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
          {serviceAvailable && <ServiceCard api={api} />}
          <section aria-labelledby="hosts-heading" className="flex flex-col gap-2">
            <h2 className="font-heading font-semibold text-foreground text-sm" id="hosts-heading">
              Connections
            </h2>
            {rows.length === 0 ? (
              <p className="rounded-lg border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
                No hosts yet. The local runtime appears here once the desktop finds it.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <TargetCard api={api} key={row.target.targetId} row={row} />
                ))}
              </ul>
            )}
          </section>
          <AddHostForm api={api} />
        </div>
      </div>
      <RemoveDialog api={api} rows={rows} />
    </div>
  );
}
