import { createContext, useContext, type ReactNode } from "react";

import type { ActionRegistry } from "./types.ts";

const ActionRegistryContext = createContext<ActionRegistry | null>(null);

export function ActionRegistryProvider({
  children,
  registry,
}: {
  readonly children: ReactNode;
  readonly registry: ActionRegistry;
}) {
  return (
    <ActionRegistryContext.Provider value={registry}>{children}</ActionRegistryContext.Provider>
  );
}

export function useActionRegistry(): ActionRegistry {
  const registry = useContext(ActionRegistryContext);
  if (registry === null) {
    throw new Error("useActionRegistry must be used inside ActionRegistryProvider");
  }
  return registry;
}
