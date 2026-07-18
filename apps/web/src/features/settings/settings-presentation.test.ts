// Presentation rules for model routing: provider naming (exact, prefixed,
// unknown), deterministic humanization, role names/colors through modelTags,
// the canonical `@role` alias display over legacy `pi/role` storage, catalog
// hit/miss selector display, and the friendly+raw search text. Pure logic —
// nothing here may ever change a stored value.
import { describe, expect, it } from "vite-plus/test";

import type { CatalogFrame, SettingsFrame } from "@t4-code/protocol";

import type { ModelChoice } from "./live-catalog.ts";
import {
  agentDisplayName,
  aliasRoleOf,
  catalogExplorerState,
  formatAlias,
  humanizeIdentifier,
  modelOptionLabel,
  modelRoutingSearchText,
  NO_ROLE_TAGS,
  providerDisplayName,
  roleDisplay,
  roleTagsFromFrames,
  selectorDisplay,
  selectorIndex,
} from "./settings-presentation.ts";

const MODELS: readonly ModelChoice[] = [
  { selector: "anthropic/claude-fable-5", label: "Claude Fable 5", provider: "anthropic", contextWindow: 200_000 },
  { selector: "google/gemini-3-flash", label: "Gemini 3 Flash", provider: "google", contextWindow: 1_000_000 },
];
const INDEX = selectorIndex(MODELS);

// Test seam: fixture frames are hand-built rather than wire-decoded.
function frames(settingsRecord: Record<string, unknown>, items: readonly Record<string, unknown>[] = []) {
  const catalog = { v: "omp-app/1", type: "catalog", hostId: "h", revision: "r1", items } as unknown as CatalogFrame;
  const settings = {
    v: "omp-app/1",
    type: "settings",
    hostId: "h",
    revision: "r1",
    settings: settingsRecord,
  } as unknown as SettingsFrame;
  return { catalog, settings };
}

describe("provider naming", () => {
  it("maps known provider ids regardless of casing", () => {
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("Anthropic")).toBe("Anthropic");
    expect(providerDisplayName("GOOGLE")).toBe("Google");
    expect(providerDisplayName("xai")).toBe("xAI");
    expect(providerDisplayName("openrouter")).toBe("OpenRouter");
    expect(providerDisplayName("github-copilot")).toBe("GitHub Copilot");
    expect(providerDisplayName("amazon-bedrock")).toBe("Amazon Bedrock");
    expect(providerDisplayName("azure-openai")).toBe("Azure OpenAI");
  });

  it("resolves suffixed provider ids by their longest known prefix", () => {
    expect(providerDisplayName("xai-oauth")).toBe("xAI");
    expect(providerDisplayName("openai-codex")).toBe("OpenAI");
    expect(providerDisplayName("google-vertex")).toBe("Google");
  });

  it("humanizes unknown providers deterministically instead of echoing raw ids", () => {
    expect(providerDisplayName("ollama")).toBe("Ollama");
    expect(providerDisplayName("my-local-gateway")).toBe("My Local Gateway");
    expect(providerDisplayName("ollama")).toBe(providerDisplayName("ollama"));
  });
});

describe("humanization", () => {
  it("title-cases hyphen/underscore/camel ids and uppercases known acronyms", () => {
    expect(humanizeIdentifier("gpt-engineer")).toBe("GPT Engineer");
    expect(humanizeIdentifier("claude-fable-5")).toBe("Claude Fable 5");
    expect(humanizeIdentifier("quick_task")).toBe("Quick Task");
    expect(humanizeIdentifier("visualFast")).toBe("Visual Fast");
    expect(agentDisplayName("gemini-executor")).toBe("Gemini Executor");
  });
});

describe("role display", () => {
  it("keeps built-in names, tags, and colors", () => {
    const slow = roleDisplay("slow");
    expect(slow.name).toBe("Thinking");
    expect(slow.tag).toBe("SLOW");
    expect(slow.color).toBe("var(--accent)");
    expect(slow.builtin).toBe(true);
  });

  it("lets modelTags rename and recolor, keeping the built-in tag", () => {
    const { catalog, settings } = frames({
      modelTags: { effective: { smol: { name: "My Smol", color: "success" }, review: { name: "Reviewer" } } },
    });
    const tags = roleTagsFromFrames(catalog, settings);
    const smol = roleDisplay("smol", tags);
    expect(smol.name).toBe("My Smol");
    expect(smol.tag).toBe("SMOL");
    expect(smol.color).toBe("var(--success)");
    const review = roleDisplay("review", tags);
    expect(review.name).toBe("Reviewer");
    expect(review.builtin).toBe(false);
  });

  it("humanizes unknown roles with a muted dot instead of echoing the id", () => {
    const custom = roleDisplay("code-review");
    expect(custom.name).toBe("Code Review");
    expect(custom.color).toBe("var(--muted-foreground)");
    expect(custom.builtin).toBe(false);
  });

  it("reads modelTags from the catalog item when the settings frame lacks it, and drops malformed entries", () => {
    const { catalog, settings } = frames({}, [
      {
        id: "setting:modelTags",
        kind: "setting",
        name: "modelTags",
        metadata: {
          path: "modelTags",
          effective: {
            plain: "Plain Name",
            bad: 42,
            colored: { color: "error" },
            invalid: { color: "not-a-color" },
          },
        },
      },
    ]);
    const tags = roleTagsFromFrames(catalog, settings);
    expect(tags.get("plain")).toEqual({ name: "Plain Name", color: null });
    expect(tags.get("bad")).toBeUndefined();
    expect(tags.get("colored")).toEqual({ name: null, color: "error" });
    expect(tags.get("invalid")).toBeUndefined();
  });
});

describe("alias display", () => {
  it("normalizes legacy pi/ aliases and canonical @ aliases to the same role", () => {
    expect(aliasRoleOf("pi/default")).toBe("default");
    expect(aliasRoleOf("@default")).toBe("default");
    expect(formatAlias("default")).toBe("@default");
    expect(aliasRoleOf("anthropic/claude-fable-5")).toBeNull();
    expect(aliasRoleOf("pi/a/b")).toBeNull();
  });

  it("presents pi/default as @default without touching the stored selector", () => {
    const display = selectorDisplay("pi/default", INDEX);
    expect(display.kind).toBe("alias");
    expect(display.mono).toBe("@default");
    expect(display.primary).toBe("Follows Default");
    expect(display.stored).toBe("pi/default");
  });

  it("names aliased custom roles through modelTags", () => {
    const { catalog, settings } = frames({ modelTags: { effective: { review: { name: "Reviewer" } } } });
    const tags = roleTagsFromFrames(catalog, settings);
    expect(selectorDisplay("@review", INDEX, tags).primary).toBe("Follows Reviewer");
  });
});

describe("selector display", () => {
  it("catalog hit: host label and friendly provider win; raw selector stays", () => {
    const display = selectorDisplay("anthropic/claude-fable-5:high", INDEX);
    expect(display.kind).toBe("model");
    expect(display.primary).toBe("Claude Fable 5");
    expect(display.provider).toBe("Anthropic");
    expect(display.mono).toBe("anthropic/claude-fable-5");
    expect(display.stored).toBe("anthropic/claude-fable-5:high");
    expect(display.thinking).toBe("high");
    expect(display.inCatalog).toBe(true);
  });

  it("catalog miss: humanizes the last id segment deterministically and says so", () => {
    const display = selectorDisplay("openrouter/moonshotai/kimi-k2.7", INDEX);
    expect(display.primary).toBe("Kimi K2.7");
    expect(display.provider).toBe("OpenRouter");
    expect(display.mono).toBe("openrouter/moonshotai/kimi-k2.7");
    expect(display.inCatalog).toBe(false);
  });

  it("wildcard patterns keep the raw base as primary with the provider named", () => {
    const display = selectorDisplay("anthropic/*", INDEX);
    expect(display.kind).toBe("pattern");
    expect(display.primary).toBe("anthropic/*");
    expect(display.provider).toBe("Anthropic");
  });

  it("picker options lead with the friendly label and keep the raw selector", () => {
    const model = MODELS[0];
    expect(model).toBeDefined();
    if (model === undefined) return;
    expect(modelOptionLabel(model)).toBe("Claude Fable 5 — anthropic/claude-fable-5");
    expect(modelOptionLabel({ ...model, label: model.selector })).toBe("anthropic/claude-fable-5");
  });
});

describe("routing search text", () => {
  const text = modelRoutingSearchText({
    roles: { default: "anthropic/claude-fable-5:high", slow: "pi/default" },
    cycle: ["smol", "default"],
    overrides: { "gemini-executor": "google/gemini-3-flash, openrouter/moonshotai/kimi-k2.7" },
    disabledAgents: ["scribe"],
    models: MODELS,
    agentNames: ["gemini-executor", "scout"],
    tags: NO_ROLE_TAGS,
  });

  it("matches friendly and raw forms for roles", () => {
    for (const term of ["claude fable 5", "anthropic/claude-fable-5", "anthropic", "thinking", "slow", "@default", "pi/default"]) {
      expect(text.roles).toContain(term);
    }
  });

  it("matches friendly and raw forms for cycle and agents", () => {
    expect(text.cycle).toContain("fast");
    expect(text.cycle).toContain("smol");
    for (const term of ["gemini executor", "gemini-executor", "kimi k2.7", "google/gemini-3-flash", "scout"]) {
      expect(text.overrides).toContain(term);
    }
    expect(text.disabled).toContain("scribe");
    expect(text.disabled).not.toContain("scout");
  });
});

describe("host catalog explorer", () => {
  const host = { hostLabel: "Work Mac", hostId: "host-work" };

  it("groups supported host entries by kind and keeps only bounded safe metadata", () => {
    const { catalog } = frames({}, [
      {
        id: "model:anthropic/claude",
        kind: "model",
        name: "Claude",
        description: "A hosted model.",
        metadata: { provider: "anthropic", modelId: "claude", contextWindow: 200_000, nested: { hidden: true } },
      },
      {
        id: "tool:search",
        kind: "tool",
        name: "Search",
        capabilities: ["catalog.read"],
        metadata: { aliases: ["find", "lookup"] },
      },
      { id: "command:compact", kind: "command", name: "Compact" },
      { id: "setting:secret", kind: "setting", name: "Not a capability" },
      { id: "future:item", kind: "future", name: "Unknown kind" },
    ]);

    const state = catalogExplorerState({ host, catalog });
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.groups.map((group) => group.kind)).toEqual(["command", "tool", "model"]);
    expect(state.groups.map((group) => group.entries.map((entry) => entry.name))).toEqual([
      ["Compact"],
      ["Search"],
      ["Claude"],
    ]);
    expect(state.groups[2]?.entries[0]?.metadata).toEqual([
      { key: "provider", value: "anthropic" },
      { key: "modelId", value: "claude" },
      { key: "contextWindow", value: "200000" },
    ]);
    expect(state.groups[1]?.entries[0]?.metadata).toEqual([
      { key: "capabilities", value: "catalog.read" },
      { key: "aliases", value: "find, lookup" },
    ]);
  });

  it("names waiting and unavailable host catalog states precisely", () => {
    expect(catalogExplorerState({ host, phase: "waiting" })).toMatchObject({
      status: "waiting",
      title: "Waiting for host catalog",
      detail: expect.stringContaining("Work Mac"),
    });
    expect(catalogExplorerState({ host, phase: "unavailable" })).toMatchObject({
      status: "unavailable",
      title: "Host catalog unavailable",
      detail: expect.stringContaining("Work Mac"),
    });
  });

  it("distinguishes an empty catalog from a catalog that is not ready", () => {
    const { catalog } = frames({}, [{ id: "setting:one", kind: "setting", name: "Setting only" }]);
    expect(catalogExplorerState({ host, catalog })).toMatchObject({
      status: "empty",
      title: "No capability entries published",
    });
    expect(catalogExplorerState({ host })).toMatchObject({
      status: "unavailable",
      title: "Host catalog unavailable",
    });
  });
});
