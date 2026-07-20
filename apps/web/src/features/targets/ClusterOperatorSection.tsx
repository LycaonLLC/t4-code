import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import { CLUSTER_OPERATOR_FEATURE } from "@t4-code/protocol";
import { Button, Spinner } from "@t4-code/ui";
import { useMemo, useState } from "react";

import { FIELD_CLASS } from "../settings/controls.tsx";
import { deriveWorkspaceData } from "../../platform/live-workspace.ts";
import {
  clusterOperatorAvailability,
  createClusterSession,
  createClusterWorkspace,
  runClusterCi,
} from "./cluster-operator.ts";

export interface ClusterOperatorSectionProps {
  readonly controller: DesktopRuntimeController;
  readonly snapshot: DesktopRuntimeSnapshot;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenPreview: (sessionId: string) => void;
}

export function ClusterOperatorSection({
  controller,
  snapshot,
  onOpenSession,
  onOpenPreview,
}: ClusterOperatorSectionProps) {
  const [query, setQuery] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [capacity, setCapacity] = useState("20Gi");
  const [sessionTitle, setSessionTitle] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const data = deriveWorkspaceData(snapshot);
  const advertised = [...snapshot.hosts.values()].some(
    (host) => host.grantedFeatures.includes(CLUSTER_OPERATOR_FEATURE),
  );
  const clusterWorkspaces = data.clusterWorkspaces ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const workspaces = useMemo(
    () =>
      normalizedQuery === ""
        ? clusterWorkspaces
        : clusterWorkspaces.filter(({ infrastructure }) =>
            `${infrastructure.displayName} ${infrastructure.id} ${infrastructure.phase}`
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          ),
    [clusterWorkspaces, normalizedQuery],
  );

  if (snapshot.clusterOperatorEnabled !== true || !advertised) return null;
  const firstHost = [...snapshot.hosts.values()].find((host) =>
    host.grantedFeatures.includes(CLUSTER_OPERATOR_FEATURE),
  );
  if (firstHost === undefined) return null;
  const targetId = firstHost.targetId;
  const availability = clusterOperatorAvailability(snapshot, targetId, "manage");

  const act = async (id: string, operation: () => Promise<unknown>) => {
    setPending(id);
    setMessage(null);
    try {
      await operation();
      setMessage("Request accepted. Status will update from the host projection.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="cluster-workspaces-heading" className="flex flex-col gap-3 border-border border-t pt-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-heading font-semibold text-foreground text-sm" id="cluster-workspaces-heading">
            Cluster workspaces
          </h2>
          <p className="text-muted-foreground text-xs">
            Infrastructure, sessions, CI, and GUI state reported by the connected cluster host.
          </p>
        </div>
        <label className="flex min-w-0 flex-col gap-1 sm:w-64">
          <span className="font-medium text-muted-foreground text-xs">Search cluster workspaces</span>
          <input
            className={FIELD_CLASS}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, id, or phase"
            type="search"
            value={query}
          />
        </label>
      </div>

      <form
        aria-label="Create cluster workspace"
        className="grid gap-2 border-border border-y py-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (displayName.trim() === "") return;
          void act("create-workspace", () =>
            createClusterWorkspace(controller, targetId, String(firstHost.hostId), {
              displayName: displayName.trim(),
              retentionPolicy: "Retain",
              capacity,
            }),
          );
        }}
      >
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">Workspace name</span>
          <input className={FIELD_CLASS} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs">Storage capacity</span>
          <input className={FIELD_CLASS} onChange={(event) => setCapacity(event.target.value)} required value={capacity} />
        </label>
        <Button className="min-h-11" disabled={!availability.enabled || pending !== null} type="submit">
          {pending === "create-workspace" && <Spinner />}
          Create cluster workspace
        </Button>
        {!availability.enabled && <p className="text-warning-foreground text-xs sm:col-span-3">{availability.reason}</p>}
      </form>

      {workspaces.length === 0 ? (
        <p className="border-border border-dashed border-y py-6 text-center text-muted-foreground text-sm">
          {normalizedQuery === ""
            ? "No cluster workspaces are projected yet. Create one to begin."
            : "No projected workspace matches this search."}
        </p>
      ) : (
        <ul className="divide-y divide-border border-border border-y">
          {workspaces.map(({ hostId, targetId: workspaceTargetId, infrastructure }) => {
            const sessions = data.sessions.filter(
              (session) => session.cluster?.workspaceId === infrastructure.id,
            );
            const condition = infrastructure.condition;
            return (
              <li className="flex flex-col gap-3 py-3" data-cluster-workspace-id={infrastructure.id} key={`${hostId}:${infrastructure.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium text-sm">{infrastructure.displayName}</h3>
                    <p className="font-mono text-muted-foreground text-xs">{infrastructure.id}</p>
                  </div>
                  <p className="text-xs">
                    <span className="font-medium">{infrastructure.phase}</span>
                    {condition === undefined ? " · Condition unknown" : ` · ${condition.reason}: ${condition.message}`}
                  </p>
                </div>
                <p className="text-muted-foreground text-xs">
                  {infrastructure.capacity ?? "Capacity unknown"} · {infrastructure.storageClass ?? "Storage class unknown"} · {infrastructure.accessMode} · {infrastructure.retentionPolicy}
                </p>
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const title = sessionTitle[infrastructure.id]?.trim();
                    void act(`session:${infrastructure.id}`, () =>
                      createClusterSession(controller, workspaceTargetId, hostId, {
                        workspaceId: infrastructure.id,
                        ...(title === undefined || title === "" ? {} : { title }),
                        runtimeProfile: "default",
                        guiEnabled: true,
                      }),
                    );
                  }}
                >
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">New session title for {infrastructure.displayName}</span>
                    <input
                      className={FIELD_CLASS}
                      onChange={(event) => setSessionTitle((current) => ({ ...current, [infrastructure.id]: event.target.value }))}
                      placeholder="Optional session title"
                      value={sessionTitle[infrastructure.id] ?? ""}
                    />
                  </label>
                  <Button className="min-h-11" disabled={!availability.enabled || pending !== null} type="submit" variant="outline">
                    {pending === `session:${infrastructure.id}` && <Spinner />}
                    Create session with GUI
                  </Button>
                </form>
                {sessions.length > 0 && (
                  <ul aria-label={`Sessions in ${infrastructure.displayName}`} className="flex flex-col gap-2">
                    {sessions.map((session) => {
                      const ref = [...snapshot.projection.sessionIndex.values()].find(
                        (candidate) => `${encodeURIComponent(String(candidate.hostId))}/${encodeURIComponent(String(candidate.sessionId))}` === session.id,
                      );
                      const ci = session.ci;
                      const exactCi = ci?.correlation === "exact" && ref !== undefined;
                      return (
                        <li className="flex flex-col gap-2 bg-secondary/40 px-3 py-2 sm:flex-row sm:items-center" key={session.id}>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-sm">{session.title}</p>
                            <p className="text-muted-foreground text-xs">
                              {session.cluster?.infrastructurePhase ?? "Runtime phase unknown"} · GUI {session.cluster?.gui.state ?? "unknown"}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {ci === undefined
                                ? "CI status unknown"
                                : `${ci.branch ?? ci.ref ?? "Branch unknown"} · ${ci.commit ?? "Commit unknown"} · ${ci.status}${ci.currentStage === undefined ? "" : ` · ${ci.currentStage}`}`}
                            </p>
                            {ci !== undefined && ci.correlation !== "exact" && (
                              <p className="text-warning-foreground text-xs">CI correlation is unknown; a run cannot be triggered.</p>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button className="min-h-11" onClick={() => onOpenSession(session.id)} size="sm" variant="outline">Inspect and steer</Button>
                            {session.cluster?.gui.state === "Ready" && (
                              <Button className="min-h-11" onClick={() => onOpenPreview(session.id)} size="sm" variant="outline">Open GUI</Button>
                            )}
                            {exactCi && ci !== undefined && ref !== undefined && (
                              <Button
                                className="min-h-11"
                                disabled={pending !== null}
                                onClick={() => void act(`ci:${session.id}`, () => runClusterCi(controller, workspaceTargetId, hostId, String(ref.sessionId), ref.revision, {
                                  provider: "woodpecker",
                                  action: "run",
                                  repositoryId: ci.repositoryId,
                                  ref: ci.ref,
                                  commit: ci.commit,
                                }))}
                                size="sm"
                              >
                                {pending === `ci:${session.id}` && <Spinner />}
                                Run CI
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {message !== null && <p aria-live="polite" className="text-muted-foreground text-xs" role="status">{message}</p>}
    </section>
  );
}
