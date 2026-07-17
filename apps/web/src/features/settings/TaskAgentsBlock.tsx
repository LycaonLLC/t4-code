// Specialized editor for delegated task agents: joins the host's agent
// catalog with `task.agentModelOverrides` (record of agent → model selector
// or ordered comma-separated fallback chain) and `task.disabledAgents`.
// Chains are edited as an ordered list of selectors — add, remove, reorder —
// and always serialize back through the single string setting; untouched
// entries are never rewritten. All edits stage drafts on the same setting
// ids through the same settings store as the generic rows.
import { Badge, Button, cn, IconButton } from "@t4-code/ui";
import { ArrowDown, ArrowUp, Minus, Plus } from "lucide-react";
import { useState } from "react";

import { FIELD_CLASS } from "./controls.tsx";
import type { AgentCatalog, ModelChoice } from "./live-catalog.ts";
import {
  draftedValue,
  listValue,
  moveItem,
  parseChain,
  recordValue,
  selectorAdvisory,
  serializeChain,
  validateSelector,
} from "./roles-model.ts";
import { SettingRowView } from "./SettingRow.tsx";
import { agentDisplayName, modelOptionLabel, selectorDisplay, selectorIndex } from "./settings-presentation.ts";
import { useSettings, type SettingsStoreApi } from "./settings-store.ts";

export const OVERRIDES_SETTING_ID = "task.agentModelOverrides";
export const DISABLED_SETTING_ID = "task.disabledAgents";

function EnabledSwitch({
  agent,
  enabled,
  onChange,
}: {
  readonly agent: string;
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      aria-checked={enabled}
      aria-label={`${agent} enabled`}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        enabled ? "border-primary bg-primary" : "border-input bg-secondary",
      )}
      onClick={() => onChange(!enabled)}
      role="switch"
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block size-4 rounded-full shadow-xs transition-transform duration-(--motion-duration-fast)",
          enabled ? "translate-x-4.5 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground",
        )}
      />
    </button>
  );
}

function ChainEditor({
  agent,
  chain,
  models,
  onCommit,
  onClear,
  onCancel,
}: {
  readonly agent: string;
  readonly chain: readonly string[];
  readonly models: readonly ModelChoice[];
  readonly onCommit: (entries: readonly string[]) => void;
  readonly onClear: () => void;
  readonly onCancel: () => void;
}) {
  const [entries, setEntries] = useState<readonly string[]>(chain);
  const [pending, setPending] = useState("");
  const catalogSelectors = new Set(models.map((model) => model.selector));
  const modelIndex = selectorIndex(models);
  const agentName = agentDisplayName(agent);
  const pendingError = pending.length === 0 ? null : validateSelector(pending);

  const add = (selector: string) => {
    if (validateSelector(selector) !== null || entries.includes(selector)) return;
    setEntries([...entries, selector]);
    setPending("");
  };

  return (
    <div className="flex w-full max-w-96 flex-col gap-1.5 rounded-md border border-border bg-secondary/40 p-2">
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">No models yet. Add at least one, in fallback order.</p>
      ) : (
        <ol aria-label={`Model fallback chain for ${agentName}`} className="flex flex-col gap-1">
          {entries.map((entry, index) => {
            const advisory = selectorAdvisory(entry, null, catalogSelectors);
            const display = selectorDisplay(entry, modelIndex);
            return (
              <li className="flex items-center gap-1" key={`${entry}-${index}`}>
                <span aria-hidden="true" className="w-4 font-mono text-muted-foreground text-xs">
                  {index + 1}.
                </span>
                <span className="min-w-0 shrink truncate text-xs" title={display.stored}>
                  {display.primary}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={display.stored}>
                  {display.mono}
                </span>
                {advisory !== null && <Badge variant="outline">Not in catalog</Badge>}
                <IconButton
                  aria-label={`Move ${display.primary} earlier`}
                  disabled={index === 0}
                  onClick={() => setEntries(moveItem(entries, index, -1))}
                  size="icon-xs"
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  aria-label={`Move ${display.primary} later`}
                  disabled={index === entries.length - 1}
                  onClick={() => setEntries(moveItem(entries, index, 1))}
                  size="icon-xs"
                >
                  <ArrowDown />
                </IconButton>
                <IconButton
                  aria-label={`Remove ${display.primary}`}
                  onClick={() => setEntries(entries.filter((_, at) => at !== index))}
                  size="icon-xs"
                >
                  <Minus />
                </IconButton>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex items-center gap-1.5">
        <label className="sr-only" htmlFor={`chain-pick-${agent}`}>
          Add a catalog model for {agentName}
        </label>
        <select
          className={cn(FIELD_CLASS, "h-7 w-40")}
          id={`chain-pick-${agent}`}
          onChange={(event) => {
            if (event.target.value.length > 0) add(event.target.value);
            event.target.value = "";
          }}
          value=""
        >
          <option value="">Add from catalog…</option>
          {models
            .filter((model) => !entries.includes(model.selector))
            .map((model) => (
              <option key={model.selector} value={model.selector}>
                {modelOptionLabel(model)}
              </option>
            ))}
        </select>
        <input
          aria-label={`Type a model selector for ${agentName}`}
          className={cn(FIELD_CLASS, "h-7 min-w-0 flex-1 font-mono")}
          onChange={(event) => setPending(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (pendingError === null) add(pending);
            }
          }}
          placeholder="provider/model-id"
          spellCheck={false}
          type="text"
          value={pending}
        />
        <IconButton
          aria-label={`Add ${pending || "the typed selector"} to the chain`}
          disabled={pending.length === 0 || pendingError !== null}
          onClick={() => add(pending)}
          size="icon-xs"
        >
          <Plus />
        </IconButton>
      </div>
      {pendingError !== null && (
        <p className="text-destructive-foreground text-xs" role="alert">
          {pendingError}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {chain.length > 0 && (
          <Button className="me-auto" onClick={onClear} size="xs" variant="ghost">
            Clear override
          </Button>
        )}
        <Button onClick={onCancel} size="xs" variant="ghost">
          Cancel
        </Button>
        <Button disabled={entries.length === 0} onClick={() => onCommit(entries)} size="xs">
          Use these models
        </Button>
      </div>
    </div>
  );
}

export function TaskAgentsBlock({
  api,
  models,
  agents,
  hostLabel,
}: {
  readonly api: SettingsStoreApi;
  readonly models: readonly ModelChoice[];
  readonly agents: AgentCatalog;
  readonly hostLabel: string;
}) {
  const viewModel = useSettings(api, (state) => state.viewModel);
  const editScope = useSettings(api, (state) => state.editScope);
  const drafts = useSettings(api, (state) => state.drafts);
  const draftErrors = useSettings(api, (state) => state.draftErrors);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);

  const overridesRow = viewModel.rowsById.get(OVERRIDES_SETTING_ID);
  const disabledRow = viewModel.rowsById.get(DISABLED_SETTING_ID);
  if (overridesRow === undefined && disabledRow === undefined) return null;

  const overridesValue =
    overridesRow === undefined ? {} : recordValue(draftedValue(overridesRow, editScope, drafts[OVERRIDES_SETTING_ID]));
  const disabledValue =
    disabledRow === undefined ? [] : listValue(draftedValue(disabledRow, editScope, drafts[DISABLED_SETTING_ID]));

  const overridesEditable =
    overridesRow !== undefined && overridesRow.control.kind === "map" && overridesRow.unavailableReason === null && overridesValue !== null;
  const disabledEditable =
    disabledRow !== undefined && disabledRow.control.kind === "list" && disabledRow.unavailableReason === null && disabledValue !== null;

  const overrides = overridesValue ?? {};
  const disabled = disabledValue ?? [];
  const state = api.getState();

  const stageOverrides = (next: Record<string, string>) => state.stageValue(OVERRIDES_SETTING_ID, next);
  const stageDisabled = (next: readonly string[]) => state.stageValue(DISABLED_SETTING_ID, [...next]);

  // Rows: every discovered agent, plus config-only names that survive in the
  // overrides or disabled lists after the agent stops being discoverable.
  const discovered = new Set(agents.agents.map((agent) => agent.name));
  const configOnly = [...new Set([...Object.keys(overrides), ...disabled])]
    .filter((name) => !discovered.has(name))
    .sort((a, b) => a.localeCompare(b));

  const dirty = drafts[OVERRIDES_SETTING_ID] !== undefined || drafts[DISABLED_SETTING_ID] !== undefined;

  const modelIndex = selectorIndex(models);

  const renderAgentRow = (name: string, description: string, isDiscovered: boolean) => {
    const friendly = agentDisplayName(name);
    const override = overrides[name];
    const chain = override === undefined ? [] : parseChain(override);
    const single = chain.length === 1 && chain[0] !== undefined ? selectorDisplay(chain[0], modelIndex) : null;
    const isDisabled = disabled.includes(name);
    return (
      <div
        className={cn("flex flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-2.5", isDisabled && "opacity-64")}
        data-agent={name}
        key={name}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground text-sm">{friendly}</span>
            <span className="font-mono text-muted-foreground text-xs" title={`Configured as ${name}`}>
              {name}
            </span>
            {isDisabled && <Badge variant="outline">Disabled</Badge>}
            {!isDiscovered && <Badge variant="outline">Not discovered on this host</Badge>}
          </div>
          {description.length > 0 && (
            <p className="max-w-[70ch] truncate text-muted-foreground text-xs" title={description}>
              {description}
            </p>
          )}
        </div>
        <div className="ms-auto flex min-w-0 flex-col items-end gap-1">
          {editingAgent === name && overridesEditable ? (
            <ChainEditor
              agent={name}
              chain={chain}
              models={models}
              onCancel={() => setEditingAgent(null)}
              onClear={() => {
                const { [name]: _dropped, ...rest } = overrides;
                stageOverrides(rest);
                setEditingAgent(null);
              }}
              onCommit={(entries) => {
                stageOverrides({ ...overrides, [name]: serializeChain(entries) });
                setEditingAgent(null);
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {override === undefined ? (
                <span className="text-muted-foreground text-xs">Agent default</span>
              ) : single !== null ? (
                <>
                  <span className="max-w-48 truncate text-xs" title={single.stored}>
                    {single.primary}
                  </span>
                  <span className="max-w-48 truncate font-mono text-muted-foreground text-xs" title={single.stored}>
                    {single.mono}
                  </span>
                </>
              ) : (
                <span className="font-mono text-xs" title={override}>
                  {chain.length} models
                </span>
              )}
              {override !== undefined && <Badge variant="secondary">Override</Badge>}
              {overridesEditable && (
                <Button onClick={() => setEditingAgent(name)} size="xs" variant="outline">
                  Change…
                </Button>
              )}
              {overridesEditable && override !== undefined && (
                <Button
                  aria-label={`Clear the model override for ${friendly}`}
                  onClick={() => {
                    const { [name]: _dropped, ...rest } = overrides;
                    stageOverrides(rest);
                  }}
                  size="xs"
                  variant="ghost"
                >
                  Clear override
                </Button>
              )}
              {disabledEditable && (
                <EnabledSwitch
                  agent={friendly}
                  enabled={!isDisabled}
                  onChange={(enabled) =>
                    stageDisabled(enabled ? disabled.filter((entry) => entry !== name) : [...disabled, name])
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <section aria-labelledby="task-agents-heading" className="mt-3">
      <div className="mb-2 flex flex-col gap-0.5">
        <h3 className="font-heading font-semibold text-foreground text-sm" id="task-agents-heading">
          Task agents
          {dirty && (
            <Badge className="ms-1.5" variant="secondary">
              Unsaved
            </Badge>
          )}
        </h3>
        <p className="max-w-[70ch] text-muted-foreground text-xs">
          Delegated agents on {hostLabel} and the models they run on. An override here beats the
          agent's own default, and may be an ordered fallback chain.
        </p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {!overridesEditable && overridesRow !== undefined && (
          <div>
            <div className="flex items-center gap-1.5 px-4 pt-3">
              <Badge variant="outline">Showing raw values</Badge>
            </div>
            <SettingRowView
              draft={drafts[OVERRIDES_SETTING_ID]}
              draftError={draftErrors[OVERRIDES_SETTING_ID]}
              editScope={editScope}
              onClear={state.stageClear}
              onDiscard={state.discardDraft}
              onStage={state.stageValue}
              row={overridesRow}
            />
          </div>
        )}
        {!disabledEditable && disabledRow !== undefined && (
          <div>
            <div className="flex items-center gap-1.5 px-4 pt-3">
              <Badge variant="outline">Showing raw values</Badge>
            </div>
            <SettingRowView
              draft={drafts[DISABLED_SETTING_ID]}
              draftError={draftErrors[DISABLED_SETTING_ID]}
              editScope={editScope}
              onClear={state.stageClear}
              onDiscard={state.discardDraft}
              onStage={state.stageValue}
              row={disabledRow}
            />
          </div>
        )}
        {agents.unavailableReason !== null && (
          <p className="px-4 py-2.5 text-muted-foreground text-xs">{agents.unavailableReason}</p>
        )}
        {(overridesEditable || disabledEditable) && (
          <>
            {agents.agents.map((agent) => renderAgentRow(agent.name, agent.description, true))}
            {configOnly.map((name) => renderAgentRow(name, "", false))}
            {agents.agents.length === 0 && configOnly.length === 0 && agents.unavailableReason === null && (
              <p className="px-4 py-2.5 text-muted-foreground text-xs">
                No delegated agents are configured or discovered on this host.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
