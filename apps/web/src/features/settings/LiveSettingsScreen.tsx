// Desktop settings surface: binds SettingsWorkspace to the live runtime.
// The catalog and values come only from the active host's frames. Store
// lifecycle lives in live-screen-model.ts, which creates the store whenever
// both frames exist — including when they arrive AFTER this screen mounts —
// feeds newer host revisions in (drafts survive), and names connection and
// protocol failures so the screen never spins forever. Saves flow through
// the live settings.write controller; the restart banner gains a real,
// serialized service restart for the local host only. The header offers an
// explicit connected-host selection (each host keeps its own drafts) and the
// active host's account-broker status.
import type { DesktopRuntimeController } from "@t4-code/client";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@t4-code/ui";
import { useRef, useState, useSyncExternalStore } from "react";

import { rendererPlatform } from "../../state/store-instance.ts";
import { useAppUpdateState } from "../updates/update-store.ts";
import type { SaveChallenge } from "./live-controller.ts";
import type { HostSelection } from "./HostSelector.tsx";
import {
  catalogExplorerInputForLiveState,
  createLiveSettingsScreenModel,
  type LiveSettingsScreenModel,
} from "./live-screen-model.ts";
import { SettingsWorkspace, type RestartAction } from "./SettingsWorkspace.tsx";
import { UnavailableSettingsWorkspace } from "./UnavailableSettingsWorkspace.tsx";

interface PendingChallenge {
  readonly challenge: SaveChallenge;
  readonly decide: (decision: "approve" | "deny") => void;
}

interface RestartState {
  readonly busy: boolean;
  readonly notice: string | null;
}

const WAIT_COPY: Record<"no-host" | "connecting" | "disconnected" | "not-published", { title: string; detail: string; spin: boolean }> = {
  "no-host": {
    title: "No host is connected",
    detail: "Settings open once a host answers. Connect or pair one under Hosts.",
    spin: false,
  },
  connecting: {
    title: "Connecting to the host",
    detail: "Settings open as soon as the connection is up.",
    spin: true,
  },
  disconnected: {
    title: "This host is not connected",
    detail: "Reconnect it under Hosts, or pick another connected host above.",
    spin: false,
  },
  "not-published": {
    title: "Waiting for the host's settings",
    detail: "Connected. The host has not published its settings catalog yet.",
    spin: true,
  },
};


export function LiveSettingsScreen({
  controller,
  onBack,
  onOpenHosts,
}: {
  readonly controller: DesktopRuntimeController;
  readonly onBack: () => void;
  readonly onOpenHosts: () => void;
}) {
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [restart, setRestart] = useState<RestartState>({ busy: false, notice: null });

  const modelRef = useRef<LiveSettingsScreenModel | null>(null);
  if (modelRef.current === null) {
    modelRef.current = createLiveSettingsScreenModel({
      runtime: controller,
      onChallenge: (incoming) => {
        const { promise, resolve } = Promise.withResolvers<"approve" | "deny">();
        setChallenge({ challenge: incoming, decide: resolve });
        return promise.finally(() => setChallenge(null));
      },
    });
  }
  const model = modelRef.current;
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const update = useAppUpdateState();

  const shell = rendererPlatform.shell;
  const restartAction: RestartAction | undefined =
    state.phase === "ready" &&
    state.active.isLocal &&
    shell?.serviceRestart !== undefined &&
    shell.serviceInspect !== undefined
      ? {
          label: "Restart OMP now",
          busy: restart.busy,
          notice: restart.notice,
          onRestart: () => {
            if (restart.busy) return;
            setRestart({ busy: true, notice: null });
            void (async () => {
              try {
                await shell.serviceRestart?.();
                const inspection = await shell.serviceInspect?.();
                setRestart({
                  busy: false,
                  notice:
                    inspection === undefined
                      ? null
                      : inspection.service === "running"
                        ? "The local runtime is running again."
                        : `The local runtime reports: ${inspection.service}.`,
                });
              } catch {
                setRestart({ busy: false, notice: "The restart did not complete. Check the host." });
              }
            })();
          },
        }
      : undefined;

  const hostSelection: HostSelection = {
    choices: state.hosts,
    activeTargetId: state.phase === "ready" ? state.active.targetId : state.activeTargetId,
    onSelect: (targetId) => model.selectHost(targetId),
  };
  const catalogExplorer = catalogExplorerInputForLiveState(controller, state);

  if (state.phase !== "ready") {
    const copy =
      state.phase === "error"
        ? { title: "Settings can't load", detail: state.message, spin: false }
        : WAIT_COPY[state.detail];
    return (
      <UnavailableSettingsWorkspace
        copy={{ ...copy, error: state.phase === "error" }}
        hostSelection={hostSelection}
        onBack={onBack}
        onOpenHosts={onOpenHosts}
        update={update}
        {...(catalogExplorer === undefined ? {} : { catalogExplorer })}
      />
    );
  }

  return (
    <>
      <SettingsWorkspace
        api={state.api}
        brokerStatus={{ view: state.broker, onRefresh: () => model.refreshBrokerStatus() }}
        catalogChoices={{ models: state.models, agents: state.agents, roleTags: state.roleTags }}
        hostSelection={hostSelection}
        {...(catalogExplorer === undefined ? {} : { catalogExplorer })}
        onBack={onBack}
        onOpenHosts={onOpenHosts}
        scopes={["global", "session"]}
        {...(restartAction === undefined ? {} : { restartAction })}
      />
      <Dialog
        onOpenChange={(open) => {
          if (!open) challenge?.decide("deny");
        }}
        open={challenge !== null}
      >
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>The host wants you to confirm</DialogTitle>
            <DialogDescription>
              {challenge?.challenge.summary ?? ""}
              {challenge?.challenge.preview != null && (
                <span className="mt-2 block rounded-md bg-secondary px-2.5 py-1.5 font-mono text-xs">
                  {challenge.challenge.preview}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => challenge?.decide("deny")} size="sm" variant="ghost">
              Don't save
            </Button>
            <Button onClick={() => challenge?.decide("approve")} size="sm">
              Confirm and save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
