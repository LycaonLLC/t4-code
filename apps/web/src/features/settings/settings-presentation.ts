// Centralized, presentation-only humanization for model routing settings:
// provider names, friendly model labels, role names/colors from `modelTags`,
// task-agent names, and the `@role` alias display form. Everything here is a
// pure read — canonical selectors, role ids, and agent ids remain the stored
// values, stay visible as muted mono metadata or tooltips, and are NEVER
// rewritten on save. The host catalog is the label authority when it names a
// model; every fallback is deterministic so the same input always renders
// the same words.
import type { CatalogFrame, SettingsFrame } from "@t4-code/protocol";

import type { ModelChoice } from "./live-catalog.ts";
import { isBuiltinRole, parseSelector, roleInfo, type ThinkingLevel } from "./roles-model.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHARS = /\p{Cc}/u;
const MAX_TAG_NAME = 64;
const MAX_ROLE_TAGS = 64;

// ─── Deterministic humanization ─────────────────────────────────────────────

/** Acronyms kept uppercase when a raw id is humanized for display. */
const ID_ACRONYMS: Readonly<Record<string, true>> = {
  ai: true,
  api: true,
  aws: true,
  cli: true,
  glm: true,
  gpt: true,
  io: true,
  llm: true,
  mcp: true,
  omp: true,
  qa: true,
  sdk: true,
  tts: true,
  tui: true,
  ui: true,
  ux: true,
};

/**
 * `gpt-engineer` → "GPT Engineer", `claude-fable-5` → "Claude Fable 5",
 * `quickTask` → "Quick Task". Split on case changes, hyphens, underscores,
 * and spaces; title-case words; known acronyms go uppercase. Never invents
 * words — a token it can't improve passes through capitalized.
 */
export function humanizeIdentifier(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) =>
      ID_ACRONYMS[word.toLowerCase()] === true
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

// ─── Providers ───────────────────────────────────────────────────────────────

/** Friendly names for provider ids OMP routes through. Lowercase keys. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  gemini: "Google",
  xai: "xAI",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  copilot: "GitHub Copilot",
  "amazon-bedrock": "Amazon Bedrock",
  bedrock: "Amazon Bedrock",
  "azure-openai": "Azure OpenAI",
  azure: "Azure OpenAI",
};

/**
 * Friendly provider name. Case-insensitive; the longest hyphen-segment
 * prefix wins, so `openai-codex` → "OpenAI", `xai-oauth` → "xAI",
 * `google-vertex` → "Google". Unknown ids humanize deterministically
 * (`ollama` → "Ollama") instead of echoing raw casing.
 */
export function providerDisplayName(id: string): string {
  const segments = id.trim().toLowerCase().split("-");
  for (let end = segments.length; end > 0; end -= 1) {
    const hit = PROVIDER_NAMES[segments.slice(0, end).join("-")];
    if (hit !== undefined) return hit;
  }
  return humanizeIdentifier(id);
}

// ─── Role names and colors (modelTags) ──────────────────────────────────────

/** Presentation metadata one `modelTags` entry contributes to a role. */
export interface RoleTag {
  readonly name: string | null;
  /** OMP theme color token this app knows how to render, or null. */
  readonly color: string | null;
}

export type RoleTags = ReadonlyMap<string, RoleTag>;

export const NO_ROLE_TAGS: RoleTags = new Map();

/** OMP theme color tokens mapped onto this app's semantic CSS tokens.
 * Anything outside this list renders without a color — never a guess. */
const ROLE_COLOR_CSS: Readonly<Record<string, string>> = {
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--destructive)",
  accent: "var(--accent)",
  muted: "var(--muted-foreground)",
  dim: "var(--muted-foreground)",
};

/** Built-in role colors, mirroring OMP's model hub tags. Copy, not behavior. */
const BUILTIN_ROLE_COLOR: Readonly<Record<string, string>> = {
  default: "success",
  smol: "warning",
  slow: "accent",
  vision: "error",
  plan: "muted",
  designer: "muted",
  commit: "dim",
  tiny: "dim",
  task: "muted",
  advisor: "accent",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTagName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAG_NAME || CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * The host's `modelTags` value, read straight from the live frames. The
 * generic settings row can't hold its nested `{ name, color }` shape, so the
 * specialized editors take it from here. Malformed entries drop out; nothing
 * throws for host content.
 */
export function roleTagsFromFrames(catalog: CatalogFrame, settings: SettingsFrame): RoleTags {
  let effective: unknown;
  const valueRecord = isRecord(settings.settings) ? settings.settings.modelTags : undefined;
  if (isRecord(valueRecord)) effective = valueRecord.effective;
  if (!isRecord(effective)) {
    for (const item of catalog.items) {
      if (item.kind !== "setting") continue;
      const meta = item.metadata;
      if (!isRecord(meta) || meta.path !== "modelTags") continue;
      if (isRecord(meta.effective)) effective = meta.effective;
      break;
    }
  }
  if (!isRecord(effective)) return NO_ROLE_TAGS;
  const out = new Map<string, RoleTag>();
  for (const [role, entry] of Object.entries(effective)) {
    if (out.size >= MAX_ROLE_TAGS) break;
    if (typeof entry === "string") {
      const name = safeTagName(entry);
      if (name !== null) out.set(role, { name, color: null });
      continue;
    }
    if (!isRecord(entry)) continue;
    const name = safeTagName(entry.name);
    const color =
      typeof entry.color === "string" && ROLE_COLOR_CSS[entry.color] !== undefined ? entry.color : null;
    if (name !== null || color !== null) out.set(role, { name, color });
  }
  return out;
}

/** Everything the UI shows for one role. The id stays the stored value. */
export interface RoleDisplay {
  readonly id: string;
  /** Friendly name: modelTags name, else built-in name, else humanized id. */
  readonly name: string;
  /** Mono chip text, e.g. DEFAULT. */
  readonly tag: string;
  /** CSS color value for the role dot, or null when unknown. */
  readonly color: string | null;
  readonly builtin: boolean;
}

/** Mirrors OMP's getRoleInfo precedence: configured modelTags metadata wins
 * over built-in info; unknown roles get a humanized name and a muted dot. */
export function roleDisplay(id: string, tags: RoleTags = NO_ROLE_TAGS): RoleDisplay {
  const builtin = isBuiltinRole(id);
  const base = roleInfo(id);
  const tag = tags.get(id);
  const colorToken = tag?.color ?? (builtin ? BUILTIN_ROLE_COLOR[id] : "muted") ?? null;
  return {
    id,
    name: tag?.name ?? (builtin ? base.name : humanizeIdentifier(id)),
    tag: base.tag,
    color: colorToken === null ? null : (ROLE_COLOR_CSS[colorToken] ?? null),
    builtin,
  };
}

// ─── Selector presentation ──────────────────────────────────────────────────

/** The role a selector aliases, accepting canonical `@role` and legacy
 * `pi/role` spellings; null when the base names a model, not a role. */
export function aliasRoleOf(base: string): string | null {
  const role = base.startsWith("@") ? base.slice(1) : base.startsWith("pi/") ? base.slice(3) : null;
  if (role === null || role.length === 0 || role.includes("/")) return null;
  return role;
}

/** Canonical alias display form: `@default`. Legacy `pi/default` stays
 * readable in tooltips; saved values are never rewritten by presentation. */
export function formatAlias(role: string): string {
  return `@${role}`;
}

export interface SelectorDisplay {
  readonly kind: "model" | "alias" | "pattern";
  /** Friendly primary line: catalog label, humanized id, or "Follows …". */
  readonly primary: string;
  /** Friendly provider name; null for aliases. */
  readonly provider: string | null;
  /** Mono metadata: the raw base selector, or the normalized `@role` form. */
  readonly mono: string;
  /** The exact stored selector (thinking suffix included) for tooltips. */
  readonly stored: string;
  readonly thinking: ThinkingLevel | null;
  /** True when the base selector is an exact host-catalog entry. */
  readonly inCatalog: boolean;
}

/** Index the host's model catalog by exact selector for display lookups. */
export function selectorIndex(models: readonly ModelChoice[]): ReadonlyMap<string, ModelChoice> {
  return new Map(models.map((model) => [model.selector, model]));
}

/**
 * How a stored model selector reads on screen. Catalog labels win; a miss
 * humanizes the model id's last path segment and says so via `inCatalog`.
 * The stored string is carried through untouched.
 */
export function selectorDisplay(
  selector: string,
  models: ReadonlyMap<string, ModelChoice>,
  tags: RoleTags = NO_ROLE_TAGS,
): SelectorDisplay {
  const { base, thinking } = parseSelector(selector);
  const aliasRole = aliasRoleOf(base);
  if (aliasRole !== null) {
    return {
      kind: "alias",
      primary: `Follows ${roleDisplay(aliasRole, tags).name}`,
      provider: null,
      mono: formatAlias(aliasRole),
      stored: selector,
      thinking,
      inCatalog: false,
    };
  }
  const slash = base.indexOf("/");
  if (base.includes("*")) {
    return {
      kind: "pattern",
      primary: base,
      provider: slash > 0 ? providerDisplayName(base.slice(0, slash)) : null,
      mono: base,
      stored: selector,
      thinking,
      inCatalog: false,
    };
  }
  const choice = models.get(base);
  const providerId = choice?.provider ?? (slash > 0 ? base.slice(0, slash) : "");
  const modelId = slash > 0 ? base.slice(slash + 1) : base;
  const lastSegment = modelId.slice(modelId.lastIndexOf("/") + 1);
  return {
    kind: "model",
    primary: choice?.label ?? humanizeIdentifier(lastSegment),
    provider: providerId.length > 0 ? providerDisplayName(providerId) : null,
    mono: base,
    stored: selector,
    thinking,
    inCatalog: choice !== undefined,
  };
}

/** Catalog picker option text: friendly label first, raw selector second. */
export function modelOptionLabel(choice: ModelChoice): string {
  return choice.label === choice.selector ? choice.selector : `${choice.label} — ${choice.selector}`;
}

// ─── Task agents ─────────────────────────────────────────────────────────────

/** Friendly agent name for display; the id stays the stored/config value. */
export function agentDisplayName(id: string): string {
  return humanizeIdentifier(id);
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface ModelRoutingSearchInput {
  readonly roles: Readonly<Record<string, string>>;
  readonly cycle: readonly string[];
  readonly overrides: Readonly<Record<string, string>>;
  readonly disabledAgents: readonly string[];
  readonly models: readonly ModelChoice[];
  readonly agentNames: readonly string[];
  readonly tags: RoleTags;
}

export interface ModelRoutingSearchText {
  readonly roles: string;
  readonly cycle: string;
  readonly overrides: string;
  readonly disabled: string;
}

function roleTerms(id: string, tags: RoleTags): string[] {
  const display = roleDisplay(id, tags);
  return [id, display.name, display.tag, formatAlias(id), `pi/${id}`];
}

function selectorTerms(selector: string, models: ReadonlyMap<string, ModelChoice>, tags: RoleTags): string[] {
  const display = selectorDisplay(selector, models, tags);
  return [selector, display.mono, display.primary, ...(display.provider === null ? [] : [display.provider])];
}

/**
 * Extra lowercase search text for the routing rows, so searching either the
 * friendly form ("Thinking", "Claude Fable", "OpenAI", "@default") or the
 * raw form ("slow", "anthropic/claude-fable-5", "pi/default") surfaces the
 * Model roles and Task agents editors.
 */
export function modelRoutingSearchText(input: ModelRoutingSearchInput): ModelRoutingSearchText {
  const models = selectorIndex(input.models);
  const roleIds = new Set([...Object.keys(input.roles), ...input.cycle, ...input.tags.keys()]);
  const roles: string[] = [];
  for (const id of roleIds) roles.push(...roleTerms(id, input.tags));
  for (const selector of Object.values(input.roles)) {
    roles.push(...selectorTerms(selector, models, input.tags));
  }
  const cycle: string[] = [];
  for (const id of input.cycle) cycle.push(...roleTerms(id, input.tags));
  const agentIds = new Set([...input.agentNames, ...Object.keys(input.overrides), ...input.disabledAgents]);
  const overrides: string[] = [];
  const disabled: string[] = [];
  for (const id of agentIds) {
    const terms = [id, agentDisplayName(id)];
    overrides.push(...terms);
    if (input.disabledAgents.includes(id)) disabled.push(...terms);
  }
  for (const chain of Object.values(input.overrides)) {
    for (const entry of chain.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) overrides.push(...selectorTerms(trimmed, models, input.tags));
    }
  }
  const join = (terms: readonly string[]) => terms.join(" ").toLowerCase();
  return { roles: join(roles), cycle: join(cycle), overrides: join(overrides), disabled: join(disabled) };
}
