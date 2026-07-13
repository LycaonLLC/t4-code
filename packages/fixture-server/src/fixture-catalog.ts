import { COMMAND_DESCRIPTORS, DESKTOP_CATALOG_COMMANDS } from "@t4-code/protocol";

const FIXTURE_CYCLE_ROLES = Array.from({ length: 12 }, (_, index) =>
  index === 0 ? "default" : `cycle-${String(index + 1).padStart(2, "0")}`,
);

/** A production-shaped profile large enough to exercise phone popup scrolling. */
export function fixtureSettings(): Record<string, unknown> {
  const modelRoles = Object.fromEntries(
    FIXTURE_CYCLE_ROLES.map((role, index) => [
      role,
      `fixture/model-${String(index + 1).padStart(3, "0")}`,
    ]),
  );
  const modelTags = Object.fromEntries(
    FIXTURE_CYCLE_ROLES.map((role, index) => [
      role,
      { name: `Fixture ${String(index + 1).padStart(2, "0")}` },
    ]),
  );
  return {
    cycleOrder: { effective: FIXTURE_CYCLE_ROLES, configured: true },
    modelRoles: { effective: modelRoles, configured: true },
    modelTags: { effective: modelTags, configured: true },
    defaultThinkingLevel: { effective: "medium", configured: true },
  };
}

/** Mirrors tonight's live ratio: a short Ctrl-P cycle over a much larger catalog. */
export function fixtureCatalogItems(): Record<string, unknown>[] {
  const commands = DESKTOP_CATALOG_COMMANDS.map((name) => {
    const descriptor = COMMAND_DESCRIPTORS[name];
    if (descriptor === undefined) throw new Error(`desktop catalog command has no descriptor: ${name}`);
    return {
      id: `cmd-${name.replaceAll(".", "-")}`,
      kind: "command",
      name,
      description: `${name} fixture command`,
      capabilities: [descriptor.capability],
      supported: true,
    };
  });
  const models = Array.from({ length: 184 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return {
      id: `model-fixture-${ordinal}`,
      kind: "model",
      name: `Fixture model ${ordinal}`,
      metadata: { provider: "fixture", modelId: `model-${ordinal}` },
      supported: true,
    };
  });
  const modes = FIXTURE_CYCLE_ROLES.map((role, index) => ({
    id: `mode-role-${role}`,
    kind: "mode",
    name: role,
    description: `Fixture ${String(index + 1).padStart(2, "0")}`,
    metadata: {
      role,
      modelId: `fixture/model-${String(index + 1).padStart(3, "0")}`,
      cycle: true,
      cycleIndex: index,
    },
  }));
  return [...commands, ...models, ...modes];
}
