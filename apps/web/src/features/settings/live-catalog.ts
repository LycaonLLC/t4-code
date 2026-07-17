// Live schema adapter: folds the host's CatalogFrame (`kind: "setting"`
// items) and SettingsFrame (values + revision) into the SettingsCatalogMetadata
// shape the settings view model already renders. The host stays the only
// authority — this module validates, maps, and degrades; it never invents a
// value, a scope, or an editor. Metadata this adapter does not recognize
// turns the row read-only with an honest reason instead of guessing.
import type { CatalogFrame, CatalogItem, SettingsFrame } from "@t4-code/protocol";

import type {
  ControlMetadata,
  EditableScope,
  EnumOptionMetadata,
  SettingLayerScope,
  SettingMetadata,
  SettingsCatalogMetadata,
  SettingsSectionMetadata,
  SettingValue,
} from "./schema.ts";

// ─── The wire contract this adapter accepts ─────────────────────────────────

/** Control types the OMP desktop config authority publishes. */
const WIRE_CONTROL_TYPES = ["boolean", "number", "string", "enum", "array", "record"] as const;
type WireControlType = (typeof WIRE_CONTROL_TYPES)[number];

/**
 * Every metadata key the authority is known to emit on a `setting` catalog
 * item. Anything outside this list is a contract change we have not reviewed;
 * the row degrades to read-only rather than half-render.
 */
const KNOWN_ITEM_KEYS: ReadonlySet<string> = new Set([
  "path",
  "label",
  "description",
  "controlType",
  "options",
  "min",
  "max",
  "step",
  "unit",
  "scopes",
  "restartRequired",
  "platform",
  "availability",
  "maxItems",
  "maxEntries",
  "default",
  "effective",
  "effectiveSource",
  "configured",
  "sensitive",
  "tab",
  "group",
]);

/** Keys the per-path SettingsFrame record may carry (schema keys minus UI). */
const KNOWN_VALUE_KEYS: ReadonlySet<string> = new Set(
  [...KNOWN_ITEM_KEYS].filter((key) => !["path", "label", "description", "tab", "group"].includes(key)),
);

/**
 * Where an effective value comes from on the wire, mapped onto the renderer's
 * layer model. `configOverlay` is a launch-time config override — read-only
 * here, so it lands on the `cli` layer. Unknown sources are a contract change
 * and degrade the row.
 */
const WIRE_SOURCE_TO_LAYER: Readonly<Record<string, SettingLayerScope | "default">> = {
  override: "session",
  configOverlay: "cli",
  project: "project",
  global: "global",
  default: "default",
};

/** Scopes this surface can write against a live host. */
const WIRE_WRITABLE_SCOPES = ["global", "session"] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHARS = /\p{Cc}/u;

const MAX_TEXT = 4096;
const MAX_PATH = 128;

/** Section presentation for the tabs the OMP settings schema declares. */
const TAB_SECTIONS: Readonly<Record<string, { readonly label: string; readonly summary: string }>> = {
  general: { label: "General", summary: "Settings that don't belong to a more specific area." },
  appearance: { label: "Appearance", summary: "How the runtime presents itself." },
  interaction: { label: "Interaction", summary: "How prompts, confirmations, and input behave." },
  model: { label: "Model", summary: "Which model runs and how it is called." },
  providers: { label: "Providers", summary: "Model and service providers this host can reach." },
  context: { label: "Context", summary: "What the runtime loads into a session's context." },
  memory: { label: "Memory", summary: "Long-term memory and recall behavior." },
  files: { label: "Files", summary: "How the runtime reads, writes, and watches files." },
  shell: { label: "Shell", summary: "Shell and command execution behavior." },
  tools: { label: "Tools", summary: "Which tools are available and how they run." },
  tasks: { label: "Tasks", summary: "Background tasks and delegated agents." },
};

/** Where host settings without a curated tab land, kept out of General so
 * raw host keys never shadow the schema-organized sections. Always last. */
const ADVANCED_SECTION_ID = "advanced";
const ADVANCED_SECTION = {
  label: "Advanced",
  summary: "Host settings without a curated home yet, shown with their raw keys.",
};

/** Acronyms kept uppercase when a raw setting key is humanized for display. */
const KEY_ACRONYMS: Record<string, true> = {
  ai: true,
  api: true,
  cli: true,
  cwd: true,
  db: true,
  gc: true,
  id: true,
  io: true,
  lsp: true,
  mcp: true,
  qa: true,
  stt: true,
  tts: true,
  ttsr: true,
  ttl: true,
  tui: true,
  url: true,
  wal: true,
};

/**
 * Defensive presentation fallback ONLY: the host is the label authority, and
 * current hosts publish readable labels for every setting. When an older host
 * sends no label (or echoes the raw key as one), a dotted camel/kebab key like
 * `tui.maxInlineImages` renders as "TUI · Max Inline Images" instead of
 * masquerading as user copy. The canonical dotted key stays visible on the
 * row and searchable via the row id.
 */
export function humanizeSettingKey(path: string): string {
  return path
    .split(".")
    .map((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .split(/[-_\s]+/u)
        .filter(Boolean)
        .map((word) =>
          KEY_ACRONYMS[word.toLowerCase()] === true
            ? word.toUpperCase()
            : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(" "),
    )
    .join(" · ");
}

// ─── Result shape ───────────────────────────────────────────────────────────

export interface LiveSettingsCatalogInput {
  readonly catalog: CatalogFrame;
  readonly settings: SettingsFrame;
  /** Display name for the host, used in conflict copy. */
  readonly hostLabel: string;
}

export interface LiveSettingsCatalog {
  readonly catalog: SettingsCatalogMetadata;
  /** Layers this host actually accepts writes for. */
  readonly editableScopes: readonly EditableScope[];
  /** One line per item this adapter refused to interpret, for diagnostics. */
  readonly issues: readonly string[];
}

// ─── Field readers (return undefined instead of throwing; callers degrade) ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  if (CONTROL_CHARS.test(value)) return undefined;
  return value;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A wire value that fits the renderer's SettingValue shape; else undefined. */
function asSettingValue(value: unknown): SettingValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return safeText(value, MAX_TEXT) ?? (value.length === 0 ? value : undefined);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || CONTROL_CHARS.test(item)) return undefined;
      items.push(item);
    }
    return items;
  }
  if (isRecord(value)) {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string" || CONTROL_CHARS.test(key) || CONTROL_CHARS.test(entry)) return undefined;
      out[key] = entry;
    }
    return out;
  }
  return undefined;
}

function enumOptions(raw: unknown): readonly EnumOptionMetadata[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const options: EnumOptionMetadata[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const value = safeText(entry, 200);
      if (value === undefined) return undefined;
      options.push({ value, label: value });
      continue;
    }
    if (!isRecord(entry)) return undefined;
    const value = safeText(entry.value, 200) ?? (typeof entry.value === "number" ? String(entry.value) : undefined);
    if (value === undefined) return undefined;
    const label = safeText(entry.label, 200) ?? value;
    const help = safeText(entry.description, 2000);
    options.push({ value, label, ...(help === undefined ? {} : { help }) });
  }
  return options;
}

// ─── Per-item mapping ───────────────────────────────────────────────────────

interface WireSetting {
  readonly path: string;
  readonly meta: Record<string, unknown>;
  /** The SettingsFrame record for this path, when present and well-formed. */
  readonly values: Record<string, unknown> | undefined;
}

/**
 * Refusal: the row stays visible and read-only. The control kind is a
 * deliberate non-editor kind so the view model renders its unsupported
 * fallback; nothing about the value is shown because nothing was understood.
 */
function refusedRow(id: string, section: string, label: string, help: string): SettingMetadata {
  return {
    id,
    section,
    label,
    help,
    control: { kind: "unvalidated-metadata" },
  };
}

function controlFor(meta: Record<string, unknown>): ControlMetadata | { readonly kind: string } {
  const declared = typeof meta.controlType === "string" ? meta.controlType : "";
  if (!WIRE_CONTROL_TYPES.some((controlType) => controlType === declared)) {
    return { kind: declared === "" ? "missing-control" : declared };
  }
  switch (declared as WireControlType) {
    case "boolean":
      return { kind: "boolean" };
    case "number": {
      const min = finiteNumber(meta.min);
      const max = finiteNumber(meta.max);
      const unit = safeText(meta.unit, 16);
      return {
        kind: "number",
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(unit === undefined ? {} : { unit }),
      };
    }
    case "string":
      return { kind: "text" };
    case "enum": {
      const options = enumOptions(meta.options);
      if (options === undefined) return { kind: "malformed-enum" };
      return { kind: "enum", options };
    }
    case "array": {
      const maxItems = finiteNumber(meta.maxItems);
      return { kind: "list", ...(maxItems === undefined ? {} : { maxItems }) };
    }
    case "record":
      return { kind: "map" };
  }
}

function settingRowFrom(wire: WireSetting, section: string, issues: string[]): SettingMetadata {
  const { path, meta } = wire;
  const hostLabel = safeText(meta.label, 200);
  // Old hosts sent no label (or echoed the raw key). Humanize for display
  // only; the canonical dotted key stays as the row id, rendered and
  // searchable, so the raw key never becomes the primary label.
  const label = hostLabel !== undefined && hostLabel !== path ? hostLabel : humanizeSettingKey(path);
  const help = safeText(meta.description, 2000) ?? "";

  const unknownKeys = Object.keys(meta).filter((key) => !KNOWN_ITEM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    issues.push(`${path}: unrecognized metadata (${unknownKeys.join(", ")})`);
    return refusedRow(path, section, label, help);
  }
  const valueRecord = wire.values;
  if (valueRecord !== undefined) {
    const unknownValueKeys = Object.keys(valueRecord).filter((key) => !KNOWN_VALUE_KEYS.has(key));
    if (unknownValueKeys.length > 0) {
      issues.push(`${path}: unrecognized value metadata (${unknownValueKeys.join(", ")})`);
      return refusedRow(path, section, label, help);
    }
  }

  const sensitive = meta.sensitive === true || valueRecord?.sensitive === true;
  const configured = valueRecord?.configured === true || meta.configured === true;
  const restartRequired = meta.restartRequired === true;
  const available = meta.availability !== false;

  // The value record is the fresher word on the current value; the catalog
  // item fills in when the settings frame has no entry for this path.
  const source = valueRecord ?? meta;

  if (sensitive) {
    // Desktop authority never ships sensitive values and refuses writes to
    // them; the row shows configured / not configured and nothing else. A
    // sensitive row that arrives WITH a value is a host defect — refuse it
    // entirely so the value never reaches the render tree.
    if (meta.default !== undefined || meta.effective !== undefined || valueRecord?.default !== undefined || valueRecord?.effective !== undefined) {
      issues.push(`${path}: sensitive setting arrived with a value`);
      return refusedRow(path, section, label, help);
    }
    return {
      id: path,
      section,
      label,
      help,
      control: { kind: "secret-reference" },
      sensitive: true,
      ...(restartRequired ? { restartRequired: true } : {}),
      ...(available ? {} : { unavailable: { reason: "Not available on this computer." } }),
      layers: {
        global: {
          secret: {
            state: configured ? "set" : "missing",
            reference: path,
            source: "Managed by the host. This app can see whether it is set, never the value.",
          },
        },
      },
    };
  }

  const control = controlFor(source === meta ? meta : { ...meta, ...valueRecord });
  const defaultValue = source.default === undefined ? undefined : asSettingValue(source.default);
  if (source.default !== undefined && defaultValue === undefined) {
    issues.push(`${path}: default value has a shape this app cannot edit`);
    return refusedRow(path, section, label, help);
  }

  // Effective value + provenance. Unknown sources are refused, not guessed.
  const layers: Partial<Record<SettingLayerScope, { readonly value?: SettingValue }>> = {};
  const wireSource = source.effectiveSource;
  if (source.effective !== undefined) {
    const layer = typeof wireSource === "string" ? WIRE_SOURCE_TO_LAYER[wireSource] : undefined;
    if (layer === undefined) {
      issues.push(`${path}: unrecognized effective source ${String(wireSource)}`);
      return refusedRow(path, section, label, help);
    }
    const effective = asSettingValue(source.effective);
    if (effective === undefined) {
      issues.push(`${path}: effective value has a shape this app cannot edit`);
      return refusedRow(path, section, label, help);
    }
    if (layer !== "default") layers[layer] = { value: effective };
  }

  return {
    id: path,
    section,
    label,
    help,
    control,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(Object.keys(layers).length === 0 ? {} : { layers }),
    ...(restartRequired ? { restartRequired: true } : {}),
    ...(available ? {} : { unavailable: { reason: "Not available on this computer." } }),
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

function sectionFor(tab: string): SettingsSectionMetadata {
  if (tab === ADVANCED_SECTION_ID) return { id: tab, ...ADVANCED_SECTION };
  const known = TAB_SECTIONS[tab];
  if (known !== undefined) return { id: tab, ...known };
  const label = tab.charAt(0).toUpperCase() + tab.slice(1);
  return { id: tab, label, summary: `Settings the host groups under “${label}”.` };
}

function wireSettingFrom(item: CatalogItem, settings: SettingsFrame, issues: string[]): WireSetting | null {
  const meta = item.metadata;
  if (!isRecord(meta)) {
    issues.push(`${String(item.id)}: setting item carries no metadata`);
    return { path: safeText(item.name, MAX_PATH) ?? String(item.id), meta: {}, values: undefined };
  }
  const path = safeText(meta.path, MAX_PATH) ?? safeText(item.name, MAX_PATH);
  if (path === undefined || path.startsWith("/") || path.startsWith("~")) {
    issues.push(`${String(item.id)}: setting item has no usable path`);
    return null;
  }
  const valueRecord = settings.settings[path];
  return { path, meta, values: isRecord(valueRecord) ? valueRecord : undefined };
}

/**
 * Build the renderer catalog from live frames. Never throws for content the
 * host sent — malformed items degrade to read-only rows and are named in
 * `issues`; only a wholly missing frame pair is the caller's problem.
 */
export function buildLiveSettingsCatalog(input: LiveSettingsCatalogInput): LiveSettingsCatalog {
  const issues: string[] = [];
  const rows: SettingMetadata[] = [];
  const seen = new Set<string>();
  const tabs = new Set<string>();
  const scopeUnion = new Set<string>();

  const items = input.catalog.items.filter((item) => item.kind === "setting");
  const ordered: Array<{ wire: WireSetting; tab: string; group: string }> = [];
  for (const item of items) {
    const wire = wireSettingFrom(item, input.settings, issues);
    if (wire === null) continue;
    if (seen.has(wire.path)) {
      issues.push(`${wire.path}: duplicate setting path ignored`);
      continue;
    }
    seen.add(wire.path);
    const tab = safeText(wire.meta.tab, 64) ?? ADVANCED_SECTION_ID;
    const group = safeText(wire.meta.group, 64) ?? "";
    tabs.add(tab);
    ordered.push({ wire, tab, group });
    const scopes = wire.meta.scopes;
    if (Array.isArray(scopes)) for (const scope of scopes) if (typeof scope === "string") scopeUnion.add(scope);
  }

  // Stable order: section, then the host's group, then path.
  ordered.sort(
    (a, b) => a.tab.localeCompare(b.tab) || a.group.localeCompare(b.group) || a.wire.path.localeCompare(b.wire.path),
  );
  for (const entry of ordered) rows.push(settingRowFrom(entry.wire, entry.tab, issues));

  const sectionIds = [...tabs].sort((a, b) => {
    if (a === b) return 0;
    if (a === "general" || b === ADVANCED_SECTION_ID) return -1;
    if (b === "general" || a === ADVANCED_SECTION_ID) return 1;
    return a.localeCompare(b);
  });
  const sections = sectionIds.map(sectionFor);

  const editableScopes = WIRE_WRITABLE_SCOPES.filter(
    (scope) => scopeUnion.size === 0 || scopeUnion.has(scope),
  ) as readonly EditableScope[];

  return {
    catalog: {
      revision: String(input.settings.revision),
      hostId: String(input.settings.hostId),
      hostLabel: input.hostLabel,
      sections,
      settings: rows,
    },
    editableScopes: editableScopes.length === 0 ? ["global"] : editableScopes,
    issues,
  };
}

// ─── Model & agent choices (for the specialized settings editors) ───────────

/** One model the host advertises, ready to use as a `modelRoles` selector. */
export interface ModelChoice {
  /** `provider/modelId` — the exact selector string OMP accepts. */
  readonly selector: string;
  /** Display name from the host's catalog. */
  readonly label: string;
  readonly provider: string;
  readonly contextWindow: number | null;
}

/** Models from catalog `kind: "model"` items; unsupported items drop out. */
export function modelChoicesFromCatalog(catalog: CatalogFrame): readonly ModelChoice[] {
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const item of catalog.items) {
    if (item.kind !== "model" || item.supported === false) continue;
    const meta = isRecord(item.metadata) ? item.metadata : {};
    const provider = safeText(meta.provider, 256);
    const modelId = safeText(meta.modelId, 256);
    if (provider === undefined || modelId === undefined) continue;
    const selector = `${provider}/${modelId}`;
    if (seen.has(selector)) continue;
    seen.add(selector);
    const contextWindow = finiteNumber(meta.contextWindow);
    out.push({
      selector,
      label: safeText(item.name, 256) ?? modelId,
      provider,
      contextWindow: contextWindow ?? null,
    });
  }
  out.sort((a, b) => a.selector.localeCompare(b.selector));
  return out;
}

/** One delegated agent the host discovered. */
export interface AgentChoice {
  readonly name: string;
  readonly description: string;
}

export interface AgentCatalog {
  readonly agents: readonly AgentChoice[];
  /** Set when the host could not publish its agent registry at all. */
  readonly unavailableReason: string | null;
}

/** Agents from catalog `kind: "agent"` items, discovery failures named. */
export function agentChoicesFromCatalog(catalog: CatalogFrame): AgentCatalog {
  const agents: AgentChoice[] = [];
  const seen = new Set<string>();
  let unavailableReason: string | null = null;
  for (const item of catalog.items) {
    if (item.kind !== "agent") continue;
    if (item.supported === false) {
      unavailableReason = "The host didn't publish its agent list. Overrides are still editable.";
      continue;
    }
    const name = safeText(item.name, 256);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    agents.push({ name, description: safeText(item.description, 4096) ?? "" });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, unavailableReason: agents.length > 0 ? null : unavailableReason };
}
