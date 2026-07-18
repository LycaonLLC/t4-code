import { Badge } from "@t4-code/ui";

import {
  catalogExplorerState,
  type CatalogExplorerEntry,
  type CatalogExplorerInput,
  type CatalogExplorerState,
} from "./settings-presentation.ts";

function StatusMessage({ state }: { readonly state: Extract<CatalogExplorerState, { readonly status: "waiting" | "unavailable" | "empty" }> }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 px-3 py-3" role="status">
      <p className="font-medium text-sm">{state.title}</p>
      <p className="mt-1 text-muted-foreground text-xs">{state.detail}</p>
    </div>
  );
}

function Entry({ entry }: { readonly entry: CatalogExplorerEntry }) {
  return (
    <li className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 font-medium text-sm">{entry.name}</span>
        {!entry.supported && <Badge variant="outline">Unavailable</Badge>}
      </div>
      <p className="mt-1 break-all font-mono text-muted-foreground text-xs" title="Raw host catalog ID">
        {entry.id}
      </p>
      {entry.description !== null && <p className="mt-1 text-muted-foreground text-xs">{entry.description}</p>}
      {entry.reason !== null && <p className="mt-1 text-muted-foreground text-xs">{entry.reason}</p>}
      {entry.metadata.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {entry.metadata.map((metadata) => (
            <div className="contents" key={metadata.key}>
              <dt className="font-mono text-muted-foreground">{metadata.key}</dt>
              <dd className="min-w-0 break-words font-mono text-foreground">{metadata.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function CatalogExplorerBlock({ input }: { readonly input: CatalogExplorerInput }) {
  const state = catalogExplorerState(input);
  return (
    <section aria-labelledby="host-capabilities-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-heading font-semibold text-foreground text-sm" id="host-capabilities-heading">
          Host capabilities
        </h2>
        <p className="text-muted-foreground text-xs">
          Read-only catalog published by <span className="font-medium text-foreground">{state.host.hostLabel}</span>{" "}
          <span className="font-mono">({state.host.hostId})</span>
        </p>
      </div>

      {state.status !== "ready" ? (
        <StatusMessage state={state} />
      ) : (
        <div className="flex flex-col gap-4">
          {state.groups.map((group) => (
            <section aria-labelledby={`host-capabilities-${group.kind}`} key={group.kind}>
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="font-medium text-sm" id={`host-capabilities-${group.kind}`}>
                  {group.label}
                </h3>
                <span className="text-muted-foreground text-xs">{group.entries.length}</span>
              </div>
              <ul className="grid gap-2 sm:grid-cols-2" aria-label={`${group.label} published by ${state.host.hostLabel}`}>
                {group.entries.map((entry) => (
                  <Entry entry={entry} key={entry.id} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
