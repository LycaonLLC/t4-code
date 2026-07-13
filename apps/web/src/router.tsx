// Code-based route tree: the shell frame at the root, the no-session state
// at "/", and the active session at "/sessions/$sessionId". Hash history so
// the same bundle runs unchanged under file:// in the desktop shell.
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@t4-code/ui";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppShell } from "./components/AppShell.tsx";
import { HomePane } from "./components/HomePane.tsx";
import { SessionScreen } from "./components/SessionScreen.tsx";
import { SettingsWorkspace } from "./features/settings/index.ts";
import { LiveSettingsScreen } from "./features/settings/LiveSettingsScreen.tsx";
import { TargetsScreen } from "./features/targets/TargetsScreen.tsx";
import { createTargetsStore, type TargetsStoreApi } from "./features/targets/targets-store.ts";
import { latestSessionViewId } from "./platform/live-workspace.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "./platform/desktop-runtime.ts";
import { useShellData } from "./state/shell-data.ts";
import { RAIL_OVERLAY_QUERY, useMediaQuery } from "./hooks/useMediaQuery.ts";
import { fixtureSettingsStore } from "./state/settings-instance.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "./state/store-instance.ts";

const rootRoute = createRootRoute({ component: AppShell });

function HomeRoute() {
  const railOverlaid = useMediaQuery(RAIL_OVERLAY_QUERY);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const shellData = useShellData();
  const runtimeSnapshot = useDesktopRuntimeSnapshot();
  const browserDirect = rendererPlatform.shell !== null && rendererPlatform.shell.serviceInspect === undefined;
  const resumable =
    !browserDirect &&
    activeSessionId !== null &&
    shellData.sessions.some((session) => session.id === activeSessionId);
  if (resumable) {
    return <Navigate params={{ sessionId: activeSessionId }} to="/sessions/$sessionId" />;
  }
  // Desktop mode: the first real sessions frame selects the latest session.
  // A browser-direct Tailnet bridge intentionally stays on the live landing
  // page so opening the URL never implicitly attaches a session.
  if (runtimeSnapshot !== null && !browserDirect) {
    const latest = latestSessionViewId(runtimeSnapshot);
    if (latest !== null) {
      return <Navigate params={{ sessionId: latest }} to="/sessions/$sessionId" />;
    }
  }
  return <HomePane railOverlaid={railOverlaid} />;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute,
});

function SessionRoute() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const navigate = useNavigate();
  const [nowMs] = useState(() => Date.now());
  const shellData = useShellData();
  const session = shellData.sessions.find((entry) => entry.id === sessionId);
  const project =
    session === undefined
      ? undefined
      : shellData.projects.find((entry) => entry.id === session.projectId);

  // Activation stamps the visit and closes the overlay rail.
  useEffect(() => {
    if (session !== undefined) {
      workspaceStore.getState().activateSession(session.id, new Date().toISOString());
    }
  }, [session]);

  if (session === undefined || project === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="surface-subheader px-3">
          <span className="font-medium text-muted-foreground text-xs">Session not found</span>
        </div>
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>That session is gone</EmptyTitle>
            <EmptyDescription>
              It may have been removed, or the link is stale. The list on the left has everything
              that still exists.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void navigate({ to: "/" })} variant="outline">
              Back to all sessions
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  return <SessionScreen key={session.id} nowMs={nowMs} project={project} session={session} />;
}

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  component: SessionRoute,
});

// Settings keeps the shell frame: the rail and titlebar stay put, and
// leaving returns to "/" which resumes the previously active session.
// Desktop mode binds to the live runtime; the browser keeps the fixture
// showcase.
function SettingsRoute() {
  const navigate = useNavigate();
  const controller = desktopRuntime();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {controller !== null ? (
        <LiveSettingsScreen
          controller={controller}
          onBack={() => void navigate({ to: "/" })}
          onOpenHosts={() => void navigate({ to: "/hosts" })}
        />
      ) : (
        <SettingsWorkspace api={fixtureSettingsStore()} onBack={() => void navigate({ to: "/" })} />
      )}
    </div>
  );
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});

// One targets store per window; action state survives route changes.
let targetsStoreInstance: TargetsStoreApi | null = null;

function HostsRoute() {
  const navigate = useNavigate();
  const controller = desktopRuntime();
  const snapshot = useDesktopRuntimeSnapshot();
  if (controller === null || snapshot === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="font-medium text-sm">Hosts are managed in the desktop app</p>
        <p className="max-w-[48ch] text-muted-foreground text-xs">
          This browser showcase has no runtime to connect. Open T4 Code on your desktop to add and
          pair computers.
        </p>
        <Button onClick={() => void navigate({ to: "/settings" })} size="sm" variant="outline">
          Back to settings
        </Button>
      </div>
    );
  }
  const shell = rendererPlatform.shell;
  if (targetsStoreInstance === null) {
    targetsStoreInstance = createTargetsStore(controller, {
      ...(shell?.serviceInspect === undefined ? {} : { inspect: shell.serviceInspect }),
      ...(shell?.serviceInstall === undefined ? {} : { install: shell.serviceInstall }),
      ...(shell?.serviceStart === undefined ? {} : { start: shell.serviceStart }),
      ...(shell?.serviceStop === undefined ? {} : { stop: shell.serviceStop }),
      ...(shell?.serviceRestart === undefined ? {} : { restart: shell.serviceRestart }),
    });
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TargetsScreen
        api={targetsStoreInstance}
        onBack={() => void navigate({ to: "/settings" })}
        serviceAvailable={shell?.serviceInspect !== undefined}
        snapshot={snapshot}
      />
    </div>
  );
}

const hostsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hosts",
  component: HostsRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, settingsRoute, hostsRoute]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
