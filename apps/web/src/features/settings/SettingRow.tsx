// One setting row: label, help, layered-value facts, and the editor. The
// row never invents values — it renders exactly what the view model and the
// staged draft say, and every non-obvious state gets a text chip, never
// color alone.
import { Badge, Button, cn } from "@t4-code/ui";
import { KeyRound } from "lucide-react";

import { SettingEditor } from "./controls.tsx";
import type { SettingDraft } from "./settings-store.ts";
import type { SettingLayerScope, SettingValue } from "./schema.ts";
import { readScope, type SettingRow as SettingRowModel, valueAtScope } from "./view-model.ts";

/** Human names for configuration layers; never engine vocabulary. The wire's
 * "session" scope is a host-process runtime override — it applies to
 * everything on that host until OMP restarts, so the UI calls it a run. */
export const SCOPE_LABEL: Record<SettingLayerScope | "default", string> = {
  global: "this machine",
  project: "this project",
  session: "this run (until OMP restarts)",
  cli: "a command-line flag",
  default: "the default",
};

export function formatValue(row: SettingRowModel, value: SettingValue): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    if (row.control.kind === "duration") {
      const unit = row.control.unit === "m" ? "min" : row.control.unit;
      return `${value} ${unit}`;
    }
    if (row.control.kind === "number" && row.control.unit !== null) {
      return `${value} ${row.control.unit}`;
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (row.control.kind === "enum") {
      const option = row.control.options.find((entry) => entry.value === value);
      if (option !== undefined) return option.label;
    }
    return value.length === 0 ? "(empty)" : value;
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? "1 entry" : `${value.length} entries`;
  }
  const size = Object.keys(value).length;
  return size === 1 ? "1 entry" : `${size} entries`;
}

const SECRET_BADGE: Record<
  "set" | "missing" | "expired",
  { readonly label: string; readonly variant: "success" | "warning" | "error" }
> = {
  set: { label: "Configured", variant: "success" },
  missing: { label: "Not set", variant: "warning" },
  expired: { label: "Expired", variant: "error" },
};

function SecretFacts({ row }: { readonly row: SettingRowModel }) {
  if (row.control.kind !== "secret") return null;
  const badge = SECRET_BADGE[row.control.status.state];
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <Badge variant={badge.variant}>
        <KeyRound aria-hidden="true" />
        <span className="px-0.5">{badge.label}</span>
      </Badge>
      <p className="max-w-72 truncate font-mono text-muted-foreground text-xs" title={row.control.status.reference}>
        {row.control.status.reference}
      </p>
      <p className="max-w-72 truncate text-muted-foreground text-xs" title={row.control.status.source}>
        Stored in {row.control.status.source} — this app never reads the value.
      </p>
    </div>
  );
}

export interface SettingRowProps {
  readonly row: SettingRowModel;
  readonly editScope: Exclude<SettingLayerScope, "cli">;
  readonly draft: SettingDraft | undefined;
  readonly draftError: string | undefined;
  readonly onStage: (id: string, value: SettingValue) => void;
  readonly onClear: (id: string) => void;
  readonly onDiscard: (id: string) => void;
  readonly nested?: boolean;
}

export function SettingRowView({
  row,
  editScope,
  draft,
  draftError,
  onStage,
  onClear,
  onDiscard,
  nested = false,
}: SettingRowProps) {
  const reading = readScope(row, editScope);
  const unavailable = row.unavailableReason !== null;
  const editable =
    !unavailable &&
    row.control.kind !== "secret" &&
    row.control.kind !== "nested" &&
    row.control.kind !== "unsupported";

  // What the editor shows: the draft when staged, otherwise the value this
  // layer resolves to today. A staged clear previews the inherited value.
  let shown: SettingValue | undefined;
  if (draft === undefined) {
    shown = valueAtScope(row, editScope);
  } else if (draft.action === "set") {
    shown = draft.value;
  } else {
    shown = reading.fallbackSource === "default" ? row.defaultValue : undefined;
    if (shown === undefined && reading.fallbackSource !== null && reading.fallbackSource !== "default") {
      shown = row.layers[reading.fallbackSource]?.value;
    }
    shown ??= row.defaultValue;
  }

  const dirty = draft !== undefined;
  const setHere = reading.setHere;
  const errorText = draftError ?? (dirty ? null : row.invalidMessage);
  const effectiveElsewhere =
    row.effective !== undefined && reading.shadowedBy !== null
      ? `Right now: ${formatValue(row, row.effective.value)} — set by ${SCOPE_LABEL[reading.shadowedBy]}.`
      : null;
  const inheritedFrom =
    !setHere && !dirty && reading.fallbackSource !== null && reading.fallbackSource !== "default"
      ? (`From ${SCOPE_LABEL[reading.fallbackSource]}` as string)
      : null;
  const sourcePath = row.layers[editScope]?.sourcePath ?? null;

  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3",
        nested && "ps-8",
        unavailable && "opacity-64",
      )}
      data-setting={row.id}
      data-state={dirty ? "dirty" : undefined}
    >
      <div className="flex min-w-56 max-w-full flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="font-medium text-foreground text-sm" htmlFor={row.id}>
            {row.label}
          </label>
          {dirty && <Badge variant="secondary">Unsaved</Badge>}
          {!dirty && setHere && <Badge variant="outline">Changed</Badge>}
          {inheritedFrom !== null && <Badge variant="outline">{inheritedFrom}</Badge>}
          {reading.shadowedBy === "cli" && <Badge variant="info">Command-line flag</Badge>}
          {reading.shadowedBy === "session" && <Badge variant="info">Set for this run</Badge>}
          {row.restartRequired && <Badge variant="warning">Needs restart</Badge>}
          {errorText !== null && errorText !== undefined && <Badge variant="error">Needs attention</Badge>}
          {row.sensitive && row.control.kind !== "secret" && <Badge variant="outline">Kept out of exports</Badge>}
        </div>
        <p className="max-w-[70ch] text-muted-foreground text-xs leading-relaxed">{row.help}</p>
        <p className="max-w-[70ch] break-all font-mono text-[11px] text-muted-foreground/80">{row.id}</p>
        {unavailable && <p className="text-muted-foreground text-xs">{row.unavailableReason}</p>}
        {effectiveElsewhere !== null && (
          <p className="text-muted-foreground text-xs">{effectiveElsewhere}</p>
        )}
        {(dirty || (setHere && editable)) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {dirty && (
              <Button onClick={() => onDiscard(row.id)} size="xs" variant="ghost">
                Undo
              </Button>
            )}
            {setHere && editable && draft?.action !== "clear" && (
              <Button onClick={() => onClear(row.id)} size="xs" variant="ghost">
                Use inherited value
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="ms-auto flex min-w-0 max-w-full flex-col items-end gap-1.5 pt-0.5">
        {row.control.kind === "secret" ? (
          <SecretFacts row={row} />
        ) : (
          <SettingEditor
            control={row.control}
            disabled={!editable}
            id={row.id}
            invalid={errorText !== null && errorText !== undefined}
            onChange={(value) => onStage(row.id, value)}
            value={shown}
          />
        )}
        {errorText !== null && errorText !== undefined && (
          <p className="max-w-72 text-end text-destructive-foreground text-xs" role="alert">
            {errorText}
          </p>
        )}
        {sourcePath !== null && setHere && (
          <p className="max-w-72 truncate font-mono text-muted-foreground text-xs" title={sourcePath}>
            {sourcePath}
          </p>
        )}
      </div>
    </div>
  );
}
