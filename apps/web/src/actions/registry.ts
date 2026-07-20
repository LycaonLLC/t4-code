import type {
  ActionDefinition,
  ActionEnvironment,
  ActionExecution,
  ActionId,
  ActionInvocation,
  ActionPresentation,
  ActionRegistry,
  ActionSurface,
  AnyActionDefinition,
} from "./types.ts";

function callDefinition<K extends ActionId, T>(
  definition: ActionDefinition<K>,
  invocation: ActionInvocation<K>,
  call: (definition: ActionDefinition<K>, args: ActionInvocation<K>["args"]) => T,
): T {
  return call(definition, invocation.args);
}

/**
 * Build a registry once for the shell. Presentation and execution both read
 * current state. Execution checks availability a second time before running.
 */
export function createActionRegistry(
  definitions: readonly AnyActionDefinition[],
  environment: ActionEnvironment,
): ActionRegistry {
  const byId = new Map<ActionId, AnyActionDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error(`Duplicate action id: ${definition.id}`);
    byId.set(definition.id, definition);
  }

  const getDefinition = <K extends ActionId>(id: K): ActionDefinition<K> => {
    const definition = byId.get(id);
    if (definition === undefined) throw new Error(`Unknown action id: ${id}`);
    return definition as unknown as ActionDefinition<K>;
  };

  return {
    environment,
    definition: getDefinition,
    present: <K extends ActionId>(invocation: ActionInvocation<K>): ActionPresentation => {
      const definition = getDefinition(invocation.id);
      return callDefinition(definition, invocation, (current, args) => ({
        group: current.group,
        label: current.label(environment, args),
        description: current.description(environment, args),
        icon:
          typeof current.icon === "function"
            ? current.icon(environment, args)
            : (current.icon ?? null),
        availability: current.availability(environment, args),
      }));
    },
    execute: <K extends ActionId>(invocation: ActionInvocation<K>): ActionExecution => {
      const definition = getDefinition(invocation.id);
      return callDefinition(definition, invocation, (current, args) => {
        // This intentionally does not reuse the availability returned while
        // rendering. Active session, connection, and loaded files may change.
        const availability = current.availability(environment, args);
        if (availability.status !== "enabled") return { executed: false, availability };
        current.run(environment, args);
        return { executed: true, availability };
      });
    },
    list: (surface: ActionSurface) =>
      definitions.filter((definition) => definition.surfaces.includes(surface)),
  };
}
