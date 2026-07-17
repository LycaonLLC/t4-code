// Specialized editor for OMP model routing: the `modelRoles` record and the
// `cycleOrder` array, rendered as role rows and an orderable quick-switch
// cycle instead of raw record/array editors. No second store — every edit
// stages a draft on the same setting ids through the same settings store,
// so the save bar, CAS conflicts, and announcements behave identically.
// When a backing row arrives in a shape this block can't parse, it falls
// back to the generic editor with an honest chip instead of hiding data.
import { Badge, Button, cn, IconButton } from "@t4-code/ui";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useState } from "react";

import { FIELD_CLASS } from "./controls.tsx";
import type { ModelChoice } from "./live-catalog.ts";
import {
  draftedValue,
  isBuiltinRole,
  knownRoleIds,
  listValue,
  moveItem,
  parseSelector,
  PRIMARY_ROLE_IDS,
  recordValue,
  roleEffectNote,
  roleFallbackNote,
  selectorAdvisory,
  THINKING_LEVELS,
  type ThinkingLevel,
  validateSelector,
  withThinking,
} from "./roles-model.ts";
import type { SettingLayerScope } from "./schema.ts";
import { SettingRowView } from "./SettingRow.tsx";
import {
  aliasRoleOf,
  formatAlias,
  modelOptionLabel,
  NO_ROLE_TAGS,
  roleDisplay,
  type RoleTags,
  selectorDisplay,
  selectorIndex,
} from "./settings-presentation.ts";
import { useSettings, type SettingsStoreApi } from "./settings-store.ts";
import type { SettingRow } from "./view-model.ts";

export const ROLES_SETTING_ID = "modelRoles";
export const CYCLE_SETTING_ID = "cycleOrder";

/** Layer provenance for one role key inside the record, narrowest first. */
function roleSource(row: SettingRow, role: string): SettingLayerScope | null {
  const order: readonly SettingLayerScope[] = ["cli", "session", "project", "global"];
  for (const scope of order) {
    const layer = row.layers[scope]?.value;
    if (layer === undefined) continue;
    const record = recordValue(layer);
    if (record !== null && record[role] !== undefined) return scope;
  }
  return null;
}

const SOURCE_FACT: Record<SettingLayerScope, string> = {
  global: "Set on this machine",
  project: "Set for this project",
  session: "Set for this run",
  cli: "From a command-line flag",
};

interface RoleEditorState {
  readonly role: string;
  readonly base: string;
  readonly custom: boolean;
  readonly thinking: ThinkingLevel | "inherit";
}

function editorFor(role: string, selector: string | undefined, models: readonly ModelChoice[]): RoleEditorState {
  const parsed = selector === undefined ? null : parseSelector(selector);
  const base = parsed?.base ?? "";
  const listed = models.some((model) => model.selector === base) || aliasRoleOf(base) !== null;
  return {
    role,
    base,
    custom: base.length > 0 && !listed,
    thinking: parsed?.thinking ?? "inherit",
  };
}

/** Tiny color dot echoing the terminal's role tag color. Decorative only. */
function RoleDot({ color }: { readonly color: string | null }) {
  if (color === null) return null;
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function RoleValueEditor({
  editor,
  models,
  roleIds,
  roleTags,
  onChange,
  onApply,
  onCancel,
  catalogSelectors,
}: {
  readonly editor: RoleEditorState;
  readonly models: readonly ModelChoice[];
  readonly roleIds: readonly string[];
  readonly roleTags: RoleTags;
  readonly onChange: (next: RoleEditorState) => void;
  readonly onApply: (selector: string) => void;
  readonly onCancel: () => void;
  readonly catalogSelectors: ReadonlySet<string>;
}) {
  const selector = withThinking(editor.base, editor.thinking === "inherit" ? null : editor.thinking);
  const { base } = parseSelector(selector);
  // Canonical aliases are accepted by the runtime/catalog even though the
  // generic selector validator also serves contexts that require a slash.
  const canonicalAlias = /^@[A-Za-z0-9][A-Za-z0-9_-]*$/.test(base) && aliasRoleOf(base) !== null;
  const error = canonicalAlias ? null : validateSelector(selector);
  const advisory = error === null ? selectorAdvisory(selector, editor.role, catalogSelectors) : null;
  const editedRoleName = roleDisplay(editor.role, roleTags).name;
  // A legacy `pi/<role>` value and its canonical `@<role>` spelling pick the
  // same option; the option's value is what a fresh pick would save.
  const aliasBase = aliasRoleOf(editor.base);
  const selectValue = editor.custom ? "__custom" : aliasBase !== null ? `pi/${aliasBase}` : editor.base;
  return (
    <div className="flex w-full flex-col gap-1.5 rounded-md border border-border bg-secondary/40 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="sr-only" htmlFor={`role-model-${editor.role}`}>
          Model for {editedRoleName}
        </label>
        <select
          className={cn(FIELD_CLASS, "h-7 min-w-48 flex-1")}
          id={`role-model-${editor.role}`}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "__custom") onChange({ ...editor, custom: true });
            else onChange({ ...editor, base: value, custom: false });
          }}
          value={selectValue}
        >
          <option disabled value="">
            Pick a model
          </option>
          {models.length > 0 && (
            <optgroup label="Available on this host">
              {models.map((model) => (
                <option key={model.selector} value={model.selector}>
                  {modelOptionLabel(model)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Role alias">
            {roleIds
              .filter((id) => id !== editor.role)
              .map((id) => (
                <option key={id} value={`pi/${id}`}>
                  {formatAlias(id)} — follows {roleDisplay(id, roleTags).name}
                </option>
              ))}
          </optgroup>
          <option value="__custom">Type a selector…</option>
        </select>
        <label className="sr-only" htmlFor={`role-thinking-${editor.role}`}>
          Thinking level for {editedRoleName}
        </label>
        <select
          className={cn(FIELD_CLASS, "h-7 w-28")}
          id={`role-thinking-${editor.role}`}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              ...editor,
              thinking: value === "inherit" ? "inherit" : (value as ThinkingLevel),
            });
          }}
          value={editor.thinking}
        >
          <option value="inherit">Thinking: inherit</option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              Thinking: {level}
            </option>
          ))}
        </select>
      </div>
      {editor.custom && (
        <input
          aria-label={`Custom model selector for ${editedRoleName}`}
          className={cn(FIELD_CLASS, "h-7 w-full font-mono")}
          onChange={(event) => onChange({ ...editor, base: event.target.value })}
          placeholder="provider/model-id or provider/*"
          spellCheck={false}
          type="text"
          value={editor.base}
        />
      )}
      {error !== null && editor.base.length > 0 && (
        <p className="text-destructive-foreground text-xs" role="alert">
          {error}
        </p>
      )}
      {advisory !== null && <p className="text-warning-foreground text-xs">{advisory}</p>}
      <div className="flex items-center justify-end gap-1.5">
        <Button onClick={onCancel} size="xs" variant="ghost">
          Cancel
        </Button>
        <Button disabled={error !== null} onClick={() => onApply(selector)} size="xs">
          Use this model
        </Button>
      </div>
    </div>
  );
}

export function ModelRolesBlock({
  api,
  models,
  hostLabel,
  roleTags = NO_ROLE_TAGS,
}: {
  readonly api: SettingsStoreApi;
  readonly models: readonly ModelChoice[];
  readonly hostLabel: string;
  /** Role names/colors from the host's `modelTags` setting. */
  readonly roleTags?: RoleTags;
}) {
  const viewModel = useSettings(api, (state) => state.viewModel);
  const editScope = useSettings(api, (state) => state.editScope);
  const drafts = useSettings(api, (state) => state.drafts);
  const draftErrors = useSettings(api, (state) => state.draftErrors);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<RoleEditorState | null>(null);
  const [newRoleName, setNewRoleName] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<string | null>(null);

  const rolesRow = viewModel.rowsById.get(ROLES_SETTING_ID);
  const cycleRow = viewModel.rowsById.get(CYCLE_SETTING_ID);
  if (rolesRow === undefined && cycleRow === undefined) return null;

  const rolesValue = rolesRow === undefined ? {} : recordValue(draftedValue(rolesRow, editScope, drafts[ROLES_SETTING_ID]));
  const cycleValue = cycleRow === undefined ? [] : listValue(draftedValue(cycleRow, editScope, drafts[CYCLE_SETTING_ID]));

  const rolesEditable = rolesRow !== undefined && rolesRow.control.kind === "map" && rolesRow.unavailableReason === null && rolesValue !== null;
  const cycleEditable = cycleRow !== undefined && cycleRow.control.kind === "list" && cycleRow.unavailableReason === null && cycleValue !== null;

  const roles = rolesValue ?? {};
  const cycle = cycleValue ?? [];
  const roleIds = knownRoleIds(roles, cycle);
  const catalogSelectors = new Set(models.map((model) => model.selector));
  const modelIndex = selectorIndex(models);
  const state = api.getState();

  const stageRoles = (next: Record<string, string>) => state.stageValue(ROLES_SETTING_ID, next);
  const stageCycle = (next: readonly string[]) => state.stageValue(CYCLE_SETTING_ID, [...next]);

  const removeRole = (role: string) => {
    const { [role]: _dropped, ...rest } = roles;
    stageRoles(rest);
    if (cycleEditable && cycle.includes(role)) stageCycle(cycle.filter((entry) => entry !== role));
    if (editing?.role === role) setEditing(null);
  };

  const knownShown = showAll ? roleIds : roleIds.filter((id) => PRIMARY_ROLE_IDS.includes(id));
  const shownRoleIds =
    pendingRole !== null && !knownShown.includes(pendingRole) ? [...knownShown, pendingRole] : knownShown;
  const hiddenCount = roleIds.length - roleIds.filter((id) => PRIMARY_ROLE_IDS.includes(id)).length;

  return (
    <section aria-labelledby="model-roles-heading" className="mt-3">
      <div className="mb-2 flex flex-col gap-0.5">
        <h3 className="font-heading font-semibold text-foreground text-sm" id="model-roles-heading">
          Model roles
        </h3>
        <p className="max-w-[70ch] text-muted-foreground text-xs">
          Which model each job runs on. These are OMP settings on {hostLabel} — the terminal and
          every client follow the same routing.
        </p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {!rolesEditable && rolesRow !== undefined ? (
          <div>
            <div className="flex items-center gap-1.5 px-4 pt-3">
              <Badge variant="outline">Showing raw values</Badge>
            </div>
            <SettingRowView
              draft={drafts[ROLES_SETTING_ID]}
              draftError={draftErrors[ROLES_SETTING_ID]}
              editScope={editScope}
              onClear={state.stageClear}
              onDiscard={state.discardDraft}
              onStage={state.stageValue}
              row={rolesRow}
            />
          </div>
        ) : (
          <>
            {shownRoleIds.map((role) => {
              const info = roleDisplay(role, roleTags);
              const selector = roles[role];
              const display = selector === undefined ? null : selectorDisplay(selector, modelIndex, roleTags);
              const source = rolesRow === undefined ? null : roleSource(rolesRow, role);
              const dirty = drafts[ROLES_SETTING_ID] !== undefined;
              const advisory =
                selector === undefined ? null : selectorAdvisory(selector, role, catalogSelectors);
              return (
                <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-2.5" data-role={role} key={role}>
                  <div className="flex min-w-48 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge className="font-mono" variant="secondary">
                        <RoleDot color={info.color} />
                        {info.tag}
                      </Badge>
                      <span className="font-medium text-foreground text-sm">{info.name}</span>
                      {dirty && <Badge variant="secondary">Unsaved</Badge>}
                      {source !== null && <Badge variant="outline">{SOURCE_FACT[source]}</Badge>}
                    </div>
                    <p className="max-w-[70ch] text-muted-foreground text-xs">{roleEffectNote(role)}</p>
                    {advisory !== null && <p className="text-warning-foreground text-xs">{advisory}</p>}
                  </div>
                  <div className="ms-auto flex min-w-0 flex-col items-end gap-1">
                    {editing?.role === role ? (
                      <RoleValueEditor
                        catalogSelectors={catalogSelectors}
                        editor={editing}
                        models={models}
                        onApply={(next) => {
                          stageRoles({ ...roles, [role]: next });
                          setEditing(null);
                          if (pendingRole === role) setPendingRole(null);
                        }}
                        onCancel={() => {
                          setEditing(null);
                          if (pendingRole === role) setPendingRole(null);
                        }}
                        onChange={setEditing}
                        roleIds={roleIds}
                        roleTags={roleTags}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {selector === undefined ? (
                          <span className="text-muted-foreground text-xs">
                            Inherited — {roleFallbackNote(role)}
                          </span>
                        ) : display !== null ? (
                          <>
                            <span className="max-w-56 truncate text-foreground text-xs" title={display.stored}>
                              {display.primary}
                            </span>
                            {display.provider !== null && (
                              <span className="text-muted-foreground text-xs">{display.provider}</span>
                            )}
                            <span
                              className="max-w-56 truncate font-mono text-muted-foreground text-xs"
                              title={display.stored}
                            >
                              {display.mono}
                            </span>
                            {display.thinking !== null && <Badge variant="outline">{display.thinking}</Badge>}
                          </>
                        ) : null}
                        <Button
                          className="px-3"
                          onClick={() => setEditing(editorFor(role, selector, models))}
                          size="xs"
                          variant="outline"
                        >
                          Change…
                        </Button>
                        {selector !== undefined && (
                          <Button
                            aria-label={`Clear the model for ${info.name}`}
                            onClick={() => removeRole(role)}
                            size="xs"
                            variant="ghost"
                          >
                            {isBuiltinRole(role) ? "Clear" : "Remove"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
              {hiddenCount > 0 && (
                <Button aria-expanded={showAll} onClick={() => setShowAll(!showAll)} size="xs" variant="ghost">
                  {showAll ? <ChevronDown /> : <ChevronRight />}
                  {showAll ? "Show fewer roles" : `Show all roles (${hiddenCount} more)`}
                </Button>
              )}
              {newRoleName === null ? (
                <Button onClick={() => setNewRoleName("")} size="xs" variant="ghost">
                  <Plus />
                  New role…
                </Button>
              ) : (
                <form
                  className="flex flex-wrap items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = newRoleName.trim();
                    if (name.length === 0 || name.length > 64 || roleIds.includes(name)) return;
                    setPendingRole(name);
                    setNewRoleName(null);
                    setShowAll(true);
                    setEditing(editorFor(name, undefined, models));
                  }}
                >
                  <input
                    aria-label="New role name"
                    className={cn(FIELD_CLASS, "h-7 w-40")}
                    onChange={(event) => setNewRoleName(event.target.value)}
                    placeholder="Role name"
                    type="text"
                    value={newRoleName}
                  />
                  <Button
                    disabled={
                      newRoleName.trim().length === 0 ||
                      newRoleName.trim().length > 64 ||
                      roleIds.includes(newRoleName.trim())
                    }
                    size="xs"
                    type="submit"
                    variant="outline"
                  >
                    Add role
                  </Button>
                  <Button onClick={() => setNewRoleName(null)} size="xs" variant="ghost">
                    Cancel
                  </Button>
                  {roleIds.includes(newRoleName.trim()) && (
                    <span className="text-destructive-foreground text-xs" role="alert">
                      That role already exists.
                    </span>
                  )}
                </form>
              )}
            </div>
          </>
        )}
      </div>

      {cycleRow !== undefined && (
        <div className="mt-3">
          <div className="mb-2 flex flex-col gap-0.5">
            <h4 className="font-medium text-foreground text-sm" id="quick-switch-cycle-heading">
              Quick-switch cycle
            </h4>
            <p className="max-w-[70ch] text-muted-foreground text-xs">
              Ctrl+P in the terminal steps through these roles, in order.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            {!cycleEditable ? (
              <div>
                <Badge variant="outline">Showing raw values</Badge>
                <SettingRowView
                  draft={drafts[CYCLE_SETTING_ID]}
                  draftError={draftErrors[CYCLE_SETTING_ID]}
                  editScope={editScope}
                  onClear={state.stageClear}
                  onDiscard={state.discardDraft}
                  onStage={state.stageValue}
                  row={cycleRow}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {cycle.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    No cycle roles set. OMP uses its default order (Fast, Default, Thinking).
                  </p>
                ) : (
                  <ol aria-labelledby="quick-switch-cycle-heading" className="flex flex-wrap gap-1.5">
                    {cycle.map((role, index) => {
                      const cycleRole = roleDisplay(role, roleTags);
                      const resolvable =
                        roles[role] !== undefined || isBuiltinRole(role);
                      return (
                        <li
                          className="flex items-center gap-0.5 rounded-md border border-border bg-secondary/60 py-0.5 ps-2 pe-0.5"
                          key={`${role}-${index}`}
                          onKeyDown={(event) => {
                            if (!event.altKey) return;
                            const delta =
                              event.key === "ArrowUp" || event.key === "ArrowLeft"
                                ? -1
                                : event.key === "ArrowDown" || event.key === "ArrowRight"
                                  ? 1
                                  : 0;
                            if (delta === 0) return;
                            event.preventDefault();
                            stageCycle(moveItem(cycle, index, delta));
                          }}
                          // biome-ignore lint/a11y/noNoninteractiveTabindex: chip is a keyboard reorder target
                          tabIndex={0}
                        >
                          <span aria-hidden="true" className="font-mono text-muted-foreground text-xs">
                            ⟳{index + 1}
                          </span>
                          <RoleDot color={cycleRole.color} />
                          <span className="px-1 font-medium text-xs">{cycleRole.name}</span>
                          {!resolvable && (
                            <span className="text-warning-foreground text-xs">No model resolves for this role</span>
                          )}
                          <IconButton
                            aria-label={`Move ${cycleRole.name} earlier in the cycle`}
                            disabled={index === 0}
                            onClick={() => stageCycle(moveItem(cycle, index, -1))}
                            size="icon-xs"
                          >
                            <ArrowUp />
                          </IconButton>
                          <IconButton
                            aria-label={`Move ${cycleRole.name} later in the cycle`}
                            disabled={index === cycle.length - 1}
                            onClick={() => stageCycle(moveItem(cycle, index, 1))}
                            size="icon-xs"
                          >
                            <ArrowDown />
                          </IconButton>
                          <IconButton
                            aria-label={`Remove ${cycleRole.name} from the cycle`}
                            onClick={() => stageCycle(cycle.filter((_, at) => at !== index))}
                            size="icon-xs"
                          >
                            <X />
                          </IconButton>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {roleIds.filter((id) => !cycle.includes(id)).length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <label className="sr-only" htmlFor="cycle-add-role">
                      Add a role to the cycle
                    </label>
                    <select
                      className={cn(FIELD_CLASS, "h-7 w-48")}
                      id="cycle-add-role"
                      onChange={(event) => {
                        const role = event.target.value;
                        if (role.length === 0) return;
                        stageCycle([...cycle, role]);
                        event.target.value = "";
                      }}
                      value=""
                    >
                      <option value="">Add role to cycle…</option>
                      {roleIds
                        .filter((id) => !cycle.includes(id))
                        .map((id) => (
                          <option key={id} value={id}>
                            {roleDisplay(id, roleTags).name}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
