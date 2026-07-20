// Terminals pane: the read-only inventory of shells attached to this
// session. Agent shells are evidence — their output lives in Activity and
// there is no input path here by construction. The user's own shells link
// into the bottom drawer, which is the only interactive terminal surface.
import { Badge, Button, cn } from "@t4-code/ui";
import { SquareTerminal } from "lucide-react";
import type * as React from "react";

import { workspaceStore } from "../../state/store-instance.ts";
import {
  createTerminalStore,
  getTerminalStore,
  type TerminalDrawerStoreApi,
  useTerminalDrawer,
} from "../terminal/terminal-store.ts";
import { FamilyEmpty } from "./FamilyEmpty.tsx";
import { PaneHeading } from "./PaneHeading.tsx";
import { useInspector, type InspectorStoreApi } from "./inspector-store.ts";
import type { ShellInventoryRow } from "./model.ts";

function ShellRow({
  row,
  action,
  actionLabel,
}: {
  readonly row: ShellInventoryRow;
  readonly action: () => void;
  readonly actionLabel: string;
}) {
  const running = row.status === "running";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-(--motion-duration-fast) hover:bg-secondary/60">
      <SquareTerminal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-sm">{row.ownerLabel}</span>
          {row.owner === "agent" && (
            <Badge size="sm" variant="outline">
              Read-only
            </Badge>
          )}
        </p>
        <p className="truncate font-mono text-muted-foreground text-xs">
          {row.shell}
          {row.cwd !== null && ` · ${row.cwd}`}
        </p>
      </div>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-xs",
          running ? "text-status-working" : "text-muted-foreground",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            running ? "bg-status-working-dot" : "bg-muted-foreground/50",
          )}
        />
        {running ? "Running" : `Exited${row.exitCode !== null ? ` (${row.exitCode})` : ""}`}
      </span>
      <Button onClick={action} size="xs" variant="outline">
        {actionLabel}
      </Button>
    </div>
  );
}

export function TerminalsPane({
  api,
  sessionId,
  trailing,
}: {
  readonly api: InspectorStoreApi;
  readonly sessionId: string;
  readonly trailing?: React.ReactNode | undefined;
}) {
  const agentShells = useInspector(api, (state) => state.terminals);
  const drawerApi = getTerminalStore(sessionId);
  const userTabs = useTerminalDrawer(
    drawerApi ?? getFallbackDrawer(),
    (state) => state.tabs,
  );

  if (agentShells.length === 0 && userTabs.length === 0) {
    return <FamilyEmpty family="terminals" />;
  }

  const runningCount =
    agentShells.filter((row) => row.status === "running").length +
    userTabs.filter((tab) => tab.status === "running").length;

  const viewInActivity = (row: ShellInventoryRow) => {
    const state = api.getState();
    state.setActivityFilter("system");
    state.setActivityQuery(row.terminalId);
    workspaceStore.getState().openSessionSurface(sessionId, "activity");
  };

  const openInDrawer = (terminalId: string) => {
    drawerApi?.getState().setActiveTerminal(terminalId);
    workspaceStore.getState().setTerminalDrawerOpen(sessionId, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeading
        family="terminals"
        summary={`${agentShells.length + userTabs.length} shells · ${runningCount} running`}
        trailing={trailing}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {agentShells.length > 0 && (
          <section aria-label="Shells the session runs">
            <h3 className="px-2 pt-1 pb-0.5 text-muted-foreground text-xs">
              Run by this session — output shows in Activity, input is not possible.
            </h3>
            {agentShells.map((row) => (
              <ShellRow
                action={() => viewInActivity(row)}
                actionLabel="View in Activity"
                key={row.terminalId}
                row={row}
              />
            ))}
          </section>
        )}
        {userTabs.length > 0 && (
          <section aria-label="Your shells">
            <h3 className="px-2 pt-2.5 pb-0.5 text-muted-foreground text-xs">
              Yours — they live in the drawer at the bottom.
            </h3>
            {userTabs.map((tab) => (
              <ShellRow
                action={() => openInDrawer(tab.id)}
                actionLabel="Open drawer"
                key={tab.id}
                row={{
                  terminalId: tab.id,
                  owner: "user",
                  ownerLabel: tab.title,
                  shell: "bash",
                  cwd: null,
                  status: tab.status === "exited" ? "exited" : "running",
                  exitCode: tab.exitCode,
                  lastOutputAt: null,
                }}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

// A stable empty drawer store stand-in for sessions with no drawer factory
// installed yet (desktop bridge boot order); avoids conditional hooks.

let fallbackDrawer: TerminalDrawerStoreApi | null = null;

function getFallbackDrawer(): TerminalDrawerStoreApi {
  if (fallbackDrawer === null) {
    fallbackDrawer = createTerminalStore({
      sessionId: "__none__",
      bridge: {
        kind: "fixture",
        open: () => {
          throw new Error("No terminal bridge installed for this window.");
        },
      },
      cwd: null,
      storage: null,
    });
  }
  return fallbackDrawer;
}
