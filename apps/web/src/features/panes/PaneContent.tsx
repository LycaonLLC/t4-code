// Right-pane family body: routes the active family to its panel, bound to
// the active session's inspector store. The shell owns the frame; this seam
// owns everything inside it.
import type * as React from "react";
import { FamilyEmpty } from "./FamilyEmpty.tsx";
import { desktopRuntime } from "../../platform/desktop-runtime.ts";
import { rendererPlatform, useWorkspace } from "../../state/store-instance.ts";
import type { PaneFamily } from "../../state/workspace-store.ts";
import { installTerminalStoreFactory, createTerminalStore } from "../terminal/terminal-store.ts";
import { createFixturePtyBridge } from "../terminal/pty.ts";
import { createLivePtySessionFactory } from "../terminal/live-pty.ts";
import { ActivityPane } from "./ActivityPane.tsx";
import { AgentsPane } from "./AgentsPane.tsx";
import { AGENT_OWNED_TERMINAL_IDS, installFixtureInspector } from "./fixtures.ts";
import { FilesPane } from "./FilesPane.tsx";
import { getInspectorStore } from "./inspector-store.ts";
import { installLiveInspector } from "./live-inspector.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import { transcriptImageSourceForSession } from "../session-runtime/transcript-images.ts";
import { ReviewPane } from "./ReviewPane.tsx";
import { TerminalsPane } from "./TerminalsPane.tsx";

// Fixture wiring for the whole surface: inspector data and the sample PTY
// bridge. The Electron shell installs real factories before first render
// instead, and this branch never runs.
if (rendererPlatform.mode === "browser") {
  installFixtureInspector();
  const bridge = createFixturePtyBridge({ agentOwnedTerminalIds: AGENT_OWNED_TERMINAL_IDS });
  // Screenshot/QA boot switch: ?term=tabs|split|exited seeds drawer shells.
  const termBoot =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("term");
  installTerminalStoreFactory((sessionId) => {
    const store = createTerminalStore({ sessionId, bridge, cwd: null });
    if (termBoot !== null && store.getState().tabs.length === 0) {
      const state = store.getState();
      const first = state.openTerminal();
      if (termBoot === "split") state.splitActiveGroup("horizontal");
      if (termBoot === "tabs") state.openTerminal();
      if (termBoot === "exited") state.sendInput(first, "exit 137\r");
    }
    return store;
  });
} else {
  // Desktop: bind each drawer store to the exact live session address.
  const controller = desktopRuntime();
  if (controller !== null) {
    installLiveInspector(controller);
    installTerminalStoreFactory((viewId) => {
      const snapshot = controller.getSnapshot();
      const address = resolveLiveSession(snapshot, viewId);
      if (address === null) {
        const bridge = {
          kind: "desktop" as const,
          open: () => { throw new Error("Live session unavailable"); },
        };
        return createTerminalStore({ sessionId: viewId, bridge, cwd: null, host: { label: "Unavailable host", remote: false } });
      }
      const bridge = createLivePtySessionFactory(controller, () => controller.getSnapshot(), address);
      const target = snapshot.targets.get(address.targetId);
      return createTerminalStore({
        sessionId: viewId,
        host: { label: target?.label ?? address.hostId, remote: target?.kind !== "local" },
        bridge,
        cwd: null,
      });
    });
  }
}

export interface PaneContentProps {
  readonly family: PaneFamily;
  /** Optional trailing action forwarded to the pane heading (e.g. dock close button). */
  readonly trailing?: React.ReactNode | undefined;
}


export function PaneContent({ family, trailing }: PaneContentProps) {
  const sessionId = useWorkspace((state) => state.activeSessionId);
  const store = sessionId === null ? null : getInspectorStore(sessionId);
  if (sessionId === null || store === null) return <FamilyEmpty family={family} />;
  switch (family) {
    case "agents": {
      const controller = rendererPlatform.mode === "browser" ? null : desktopRuntime();
      const address =
        controller === null ? null : resolveLiveSession(controller.getSnapshot(), sessionId);
      const imageSource =
        address === null
          ? undefined
          : (transcriptImageSourceForSession(address.hostId, address.sessionId) ?? undefined);
      return <AgentsPane api={store} imageSource={imageSource} sessionId={sessionId} trailing={trailing} />;
    }
    case "activity":
      return <ActivityPane api={store} trailing={trailing} />;
    case "review":
      return <ReviewPane api={store} trailing={trailing} />;
    case "files":
      return <FilesPane api={store} trailing={trailing} />;
    case "terminals":
      return <TerminalsPane api={store} sessionId={sessionId} trailing={trailing} />;
  }
}
