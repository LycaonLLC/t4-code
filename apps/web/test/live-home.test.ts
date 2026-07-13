// Desktop zero-session home states against the real DesktopRuntimeController
// and a concrete fake shell: a cold bootstrap failure renders a bounded,
// path-free error with no fixture copy; a stopped local service exposes the
// start action; actions serialize while pending and always re-inspect; and
// browser mode keeps rendering the built-in sample workspace untouched.
import { describe, expect, it } from "vite-plus/test";
import { createDesktopRuntimeController, type DesktopRuntimeSnapshot } from "@t4-code/client";

import { createFixtureSessionRuntime } from "../src/features/session-runtime/controller.ts";
import { resolveRendererPlatform } from "../src/platform/bridge.ts";
import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";
import {
  createHomeActions,
  deriveDesktopHomeState,
  deriveHomeServiceView,
  homeServiceRetryDelay,
  shouldInspectHomeService,
  shouldRetryHomeService,
} from "../src/platform/home-state.ts";
import { deferred, FakeShell, makeTarget, makeWelcome } from "./fake-shell.ts";

const FULL_SUPPORT = { inspect: true, install: true, start: true } as const;

describe("cold bootstrap failure", () => {
  it("renders a bounded error state with no fixture data and no absolute paths", async () => {
    const shell = new FakeShell();
    shell.bootstrapError = new Error("spawn failed at /home/user/.local/omp/appserver token=abc123");
    const controller = createDesktopRuntimeController({ shell });

    await expect(controller.start()).rejects.toThrow();
    const snapshot = controller.getSnapshot();
    expect(snapshot.startState).toBe("error");

    const state = deriveDesktopHomeState(snapshot);
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).not.toBe("");
      expect(state.message.length).toBeLessThanOrEqual(512);
      expect(state.message.includes("/home/")).toBe(false);
      expect(state.message.includes("token=abc123")).toBe(false);
    }

    // The desktop path never falls back to the browser sample workspace.
    const workspace = deriveWorkspaceData(snapshot);
    expect(workspace.sessions).toHaveLength(0);
    expect(workspace.hosts).toHaveLength(0);
    expect(workspace.projects).toHaveLength(0);
  });
});

describe("home state classification", () => {
  it("orders connection truth over remembered start state", async () => {
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    // Before start: connecting, never an error or fake emptiness.
    expect(deriveDesktopHomeState(controller.getSnapshot()).kind).toBe("connecting");

    await controller.start();
    shell.emitFrame({ targetId: "local", frame: makeWelcome("host-a", []) });
    // Local target connected with zero sessions: genuinely empty.
    expect(deriveDesktopHomeState(controller.getSnapshot()).kind).toBe("empty");

    // The connection drops after startup: the service needs attention.
    shell.emitState({ targetId: "local", state: "disconnected" });
    expect(deriveDesktopHomeState(controller.getSnapshot()).kind).toBe("service");

    // A successful reconnect returns to the honest empty state.
    shell.emitState({ targetId: "local", state: "connected" });
    expect(deriveDesktopHomeState(controller.getSnapshot()).kind).toBe("empty");
  });

  it("uses the configured browser target and exposes pairing instead of local-service copy", async () => {
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    const base = controller.getSnapshot();
    const pairingSnapshot: DesktopRuntimeSnapshot = {
      ...base,
      targets: new Map([["remote", makeTarget("remote", "pairing-required")]]),
      connections: new Map([["remote", "pairing-required"]]),
    };
    expect(deriveDesktopHomeState(pairingSnapshot)).toEqual({
      kind: "pairing-required",
      targetId: "remote",
      label: "remote",
    });

    const connectedSnapshot: DesktopRuntimeSnapshot = {
      ...pairingSnapshot,
      targets: new Map([["remote", makeTarget("remote", "connected")]]),
      connections: new Map([["remote", "connected"]]),
    };
    expect(deriveDesktopHomeState(connectedSnapshot).kind).toBe("empty");
  });
});

describe("service card view model", () => {
  it("maps backend inspection states to honest labels and forward actions", () => {
    expect(deriveHomeServiceView(null, FULL_SUPPORT)).toMatchObject({
      label: "Checking",
      primary: null,
    });
    expect(
      deriveHomeServiceView({ definition: "missing", service: "unknown", diagnostics: "" }, FULL_SUPPORT),
    ).toMatchObject({ label: "Not installed", primary: "install", primaryLabel: "Install the service" });
    expect(
      deriveHomeServiceView({ definition: "current", service: "stopped", diagnostics: "" }, FULL_SUPPORT),
    ).toMatchObject({ label: "Installed, not running", primary: "start", primaryLabel: "Start it" });
    expect(
      deriveHomeServiceView(
        { definition: "current", service: "failed", diagnostics: "exit code 1" },
        FULL_SUPPORT,
      ),
    ).toMatchObject({ label: "Could not start", tone: "error", primary: "start", diagnostics: "exit code 1" });
    expect(
      deriveHomeServiceView({ definition: "current", service: "running", diagnostics: "" }, FULL_SUPPORT),
    ).toMatchObject({ label: "Running", tone: "success", primary: "retry" });
    // A shell without service management still offers a reconnect.
    expect(deriveHomeServiceView(null, { inspect: false, install: false, start: false })).toMatchObject({
      label: "Not connected",
      primary: "retry",
    });
    // Install support missing: no dead install button.
    expect(
      deriveHomeServiceView(
        { definition: "missing", service: "unknown", diagnostics: "" },
        { inspect: true, install: false, start: false },
      ),
    ).toMatchObject({ label: "Not installed", primary: null, primaryLabel: null });
    expect(
      deriveHomeServiceView(
        {
          definition: "missing",
          service: "unknown",
          diagnostics: "",
          issue: { code: "omp_incompatible", message: "Update the installed runtime." },
        },
        FULL_SUPPORT,
      ),
    ).toMatchObject({ label: "OMP update required", detail: "Update the installed runtime." });
    expect(
      deriveHomeServiceView(
        {
          definition: "missing",
          service: "unknown",
          diagnostics: "",
          issue: { code: "omp_not_found", message: "Install OMP first." },
        },
        FULL_SUPPORT,
      ),
    ).toMatchObject({ label: "OMP not found", detail: "Install OMP first." });
    expect(deriveHomeServiceView(null, FULL_SUPPORT, "incompatible maybe")).toMatchObject({
      label: "Check failed",
    });
  });
});

describe("service actions", () => {
  it("settles a typed incompatible inspect without a timer and recovers on a manual read", async () => {
    let available = false;
    let inspectCalls = 0;
    const actions = createHomeActions({
      serviceInspect: async () => {
        inspectCalls += 1;
        if (!available) return {
          definition: "missing",
          service: "unknown",
          diagnostics: "",
          issue: {
            code: "omp_incompatible",
            message: "Installed OMP must be updated. Choose Check again after updating.",
          },
        };
        return { definition: "current", service: "running", diagnostics: "" };
      },
      connectLocal: async () => undefined,
    });

    const first = actions.run("inspect");
    const duplicate = actions.run("inspect");
    await Promise.all([first, duplicate]);
    const failed = actions.getState();
    expect(inspectCalls).toBe(1);
    expect(failed.pending).toBeNull();
    expect(failed.consecutiveInspectionFailures).toBe(0);
    expect(failed.failure).toBeNull();
    expect(shouldInspectHomeService(true, true, failed)).toBe(false);
    expect(shouldRetryHomeService(true, true, failed)).toBe(false);
    expect(deriveHomeServiceView(failed.inspection, FULL_SUPPORT, failed.failure)).toMatchObject({
      label: "OMP update required",
      tone: "error",
      live: false,
    });
    expect([1, 2, 3, 4, 99].map(homeServiceRetryDelay)).toEqual([
      5_000,
      15_000,
      30_000,
      60_000,
      60_000,
    ]);

    available = true;
    await actions.run("inspect");
    const recovered = actions.getState();
    expect(inspectCalls).toBe(2);
    expect(recovered.failure).toBeNull();
    expect(recovered.consecutiveInspectionFailures).toBe(0);
    expect(recovered.inspection?.service).toBe("running");
  });

  it("caps generic automatic inspection retries and lets a manual retry start a fresh budget", async () => {
    let inspectCalls = 0;
    const actions = createHomeActions({
      serviceInspect: async () => {
        inspectCalls += 1;
        throw new Error("temporary IPC failure");
      },
      connectLocal: async () => undefined,
    });
    await actions.run("inspect", "automatic");
    for (let expected = 1; expected <= 4; expected += 1) {
      expect(shouldRetryHomeService(true, true, actions.getState())).toBe(true);
      await actions.run("inspect", "automatic");
      expect(actions.getState().consecutiveInspectionFailures).toBe(expected + 1);
    }
    expect(inspectCalls).toBe(5);
    expect(shouldRetryHomeService(true, true, actions.getState())).toBe(false);

    await actions.run("inspect");
    expect(inspectCalls).toBe(6);
    expect(actions.getState().consecutiveInspectionFailures).toBe(1);
    expect(shouldRetryHomeService(true, true, actions.getState())).toBe(true);
  });

  it("keeps a typed missing-OMP result stable until a manual check", async () => {
    let inspectCalls = 0;
    const actions = createHomeActions({
      serviceInspect: async () => {
        inspectCalls += 1;
        return {
          definition: "missing",
          service: "unknown",
          diagnostics: "",
          issue: { code: "omp_not_found", message: "Install OMP, then check again." },
        };
      },
      connectLocal: async () => undefined,
    });
    await actions.run("inspect", "automatic");
    expect(inspectCalls).toBe(1);
    expect(actions.getState().failure).toBeNull();
    expect(shouldRetryHomeService(true, true, actions.getState())).toBe(false);
    await actions.run("inspect");
    expect(inspectCalls).toBe(2);
  });

  it("starts a stopped service, serializes concurrent actions, and re-inspects after completion", async () => {
    const shell = new FakeShell();
    shell.inspection = { definition: "current", service: "stopped", diagnostics: "" };
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();

    const startGate = deferred<boolean>();
    const actions = createHomeActions({
      serviceInspect: () => shell.serviceInspect(),
      serviceInstall: () => shell.serviceInstall(),
      serviceStart: async () => {
        shell.startCalls += 1;
        await startGate.promise;
        return { completed: true };
      },
      connectLocal: () => controller.connect("local"),
    });

    await actions.run("inspect");
    expect(actions.getState().inspection?.service).toBe("stopped");
    expect(deriveHomeServiceView(actions.getState().inspection, FULL_SUPPORT).primary).toBe("start");

    const startRun = actions.run("start");
    expect(actions.getState().pending).toBe("start");
    // Actions serialize: a second action while one is pending is dropped.
    await actions.run("install");
    expect(shell.installCalls).toBe(0);
    expect(actions.getState().pending).toBe("start");

    // The backend confirms; the completed action re-inspects and renders
    // the reported state, never an optimistic success.
    shell.inspection = { definition: "current", service: "running", diagnostics: "" };
    startGate.resolve(true);
    await startRun;
    expect(shell.startCalls).toBe(1);
    expect(actions.getState().pending).toBeNull();
    expect(actions.getState().inspection?.service).toBe("running");
    expect(deriveHomeServiceView(actions.getState().inspection, FULL_SUPPORT).label).toBe("Running");
    // Exactly two inspections: the explicit one plus the post-start one.
    expect(shell.inspectCalls).toBe(2);
  });

  it("reports a bounded failure when an action does not complete and still re-inspects", async () => {
    const shell = new FakeShell();
    shell.inspection = { definition: "current", service: "failed", diagnostics: "exit code 1" };
    shell.serviceStartError = new Error(
      "systemctl exploded Authorization: Bearer BEARER_SECRET authorization=Basic BASIC_SECRET at \"/Users/alice/My Secret/file\" '/home/alice/My Secret/file' /usr/lib/systemd ~/Library/Application Support/Secret",
    );
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();

    const actions = createHomeActions({
      serviceInspect: () => shell.serviceInspect(),
      serviceStart: () => shell.serviceStart(),
      connectLocal: () => controller.connect("local"),
    });
    await actions.run("start");

    const state = actions.getState();
    expect(state.pending).toBeNull();
    expect(state.failure).not.toBeNull();
    expect(state.failure?.includes("/usr/")).toBe(false);
    expect(state.failure).not.toContain("BEARER_SECRET");
    expect(state.failure).not.toContain("BASIC_SECRET");
    expect(state.failure).not.toContain("/Users/alice");
    expect(state.failure).not.toContain("/home/alice");
    expect(state.failure).not.toContain("~/Library");
    expect(state.inspection?.service).toBe("failed");
    expect(shell.inspectCalls).toBe(1);
  });
});

describe("browser mode", () => {
  it("stays in fixture mode with the built-in catalog when no shell port is injected", () => {
    // No window.ompShell in this environment: the platform resolves to
    // browser and the fixture runtime keeps serving deterministic content.
    const platform = resolveRendererPlatform();
    expect(platform.mode).toBe("browser");
    expect(platform.shell).toBeNull();

    const runtime = createFixtureSessionRuntime({
      sessionKey: "sess-settings",
      variant: "default",
      tickMs: 1,
    });
    runtime.pause();
    const snapshot = runtime.getSnapshot();
    expect(snapshot.projection.entries.length).toBeGreaterThan(0);
    // Null slash catalog = the composer's built-in browser commands apply.
    expect(snapshot.slashCommands).toBeNull();
    runtime.dispose();
  });
});
