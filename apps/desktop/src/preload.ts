import { contextBridge, ipcRenderer } from "electron";
import {
  decodeDesktopEvent,
  decodeDesktopUpdateRendererReadyResult,
  decodeDesktopUpdateState,
  type BootstrapResult,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type ConnectionStateEvent,
  type ConnectResult,
  type DisconnectResult,
  type DesktopUpdateOpenEvent,
  type DesktopUpdateRendererReadyResult,
  type DesktopUpdateState,
  type PairLinkEvent,
  type PairLinksDrainResult,
  type PairRequest,
  type PairResult,
  type RendererServerFrameEvent,
  type RuntimeErrorEvent,
  type ServiceActionResult,
  type ServiceInspection,
  type TargetAddRequest,
  type TargetAddResult,
  type TargetListResult,
  type TargetRemoveResult,
  type TargetRequest,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalResult,
} from "@t4-code/protocol/desktop-ipc";
 
export interface OmpShellBridge {
  readonly kind: "desktop";
  readonly platform: "linux" | "darwin";
  readonly bootstrap: () => Promise<BootstrapResult>;
  readonly confirm: (request: ConfirmRequest) => Promise<ConfirmResult>;
  readonly terminalInput: (request: TerminalInputRequest) => Promise<TerminalResult>;
  readonly terminalResize: (request: TerminalResizeRequest) => Promise<TerminalResult>;
  readonly terminalClose: (request: TerminalCloseRequest) => Promise<TerminalResult>;
  readonly connect: (request: TargetRequest) => Promise<ConnectResult>;
  readonly disconnect: (request: TargetRequest) => Promise<DisconnectResult>;
  readonly command: (request: CommandRequest) => Promise<CommandResult>;
  readonly pair: (request: PairRequest) => Promise<PairResult>;
  readonly drainPairLinks: () => Promise<PairLinksDrainResult>;
  readonly serviceInspect: () => Promise<ServiceInspection>;
  readonly serviceInstall: () => Promise<ServiceActionResult>;
  readonly serviceStart: () => Promise<ServiceActionResult>;
  readonly serviceStop: () => Promise<ServiceActionResult>;
  readonly serviceRestart: () => Promise<ServiceActionResult>;
  readonly serviceUninstall: () => Promise<ServiceActionResult>;
  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly checkForUpdate: () => Promise<DesktopUpdateState>;
  readonly downloadUpdate: () => Promise<DesktopUpdateState>;
  readonly restartToUpdate: () => Promise<DesktopUpdateState>;
  readonly updateRendererReady: () => Promise<DesktopUpdateRendererReadyResult>;
  readonly listTargets: () => Promise<TargetListResult>;
  readonly addTarget: (request: TargetAddRequest) => Promise<TargetAddResult>;
  readonly removeTarget: (request: TargetRequest) => Promise<TargetRemoveResult>;
  readonly connectTarget: (request: TargetRequest) => Promise<ConnectResult>;
  readonly disconnectTarget: (request: TargetRequest) => Promise<DisconnectResult>;
  readonly onServerFrame: (listener: (event: RendererServerFrameEvent) => void) => () => void;
  readonly onConnectionState: (listener: (event: ConnectionStateEvent) => void) => () => void;
  readonly onRuntimeError: (listener: (event: RuntimeErrorEvent) => void) => () => void;
  readonly onPairLink: (listener: (event: PairLinkEvent) => void) => () => void;
  readonly onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  readonly onOpenUpdateSettings: (listener: (event: DesktopUpdateOpenEvent) => void) => () => void;
}

function invoke<C extends "omp:bootstrap" | "omp:connect" | "omp:disconnect" | "omp:command" | "omp:confirm" | "omp:terminal:input" | "omp:terminal:resize" | "omp:terminal:close" | "omp:pair" | "omp:pair-links:drain" | "omp:service:inspect" | "omp:service:install" | "omp:service:start" | "omp:service:stop" | "omp:service:restart" | "omp:service:uninstall" | "omp:targets:list" | "omp:targets:add" | "omp:targets:remove" | "app:update:get-state" | "app:update:check" | "app:update:download" | "app:update:restart" | "app:update:renderer-ready", R>(channel: C, payload: unknown): Promise<R> {
  return ipcRenderer.invoke(channel, { channel, payload }) as Promise<R>;
}

type SubscriptionPayload<C> = C extends "omp:server-frame"
  ? RendererServerFrameEvent
  : C extends "omp:connection-state"
    ? ConnectionStateEvent
    : C extends "omp:runtime-error"
      ? RuntimeErrorEvent
      : C extends "omp:pair-link"
        ? PairLinkEvent
        : C extends "app:update:state"
          ? DesktopUpdateState
          : DesktopUpdateOpenEvent;

function subscribe<C extends "omp:server-frame" | "omp:connection-state" | "omp:runtime-error" | "omp:pair-link" | "app:update:state" | "app:update:open">(
  channel: C,
  listener: (payload: SubscriptionPayload<C>) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
    try {
      const decoded = decodeDesktopEvent({ channel, payload: value });
      listener(decoded.payload as SubscriptionPayload<C>);
    } catch {
      // Invalid renderer events are dropped at the preload boundary.
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: OmpShellBridge = {
  kind: "desktop",
  platform: process.platform === "darwin" ? "darwin" : "linux",
  bootstrap: () => invoke("omp:bootstrap", {}),
  connect: (request) => invoke("omp:connect", request),
  confirm: (request) => invoke("omp:confirm", request),
  terminalInput: (request) => invoke("omp:terminal:input", request),
  terminalResize: (request) => invoke("omp:terminal:resize", request),
  terminalClose: (request) => invoke("omp:terminal:close", request),
  disconnect: (request) => invoke("omp:disconnect", request),
  command: (request) => invoke("omp:command", request),
  pair: (request) => invoke("omp:pair", request),
  drainPairLinks: () => invoke("omp:pair-links:drain", {}),
  serviceInspect: () => invoke("omp:service:inspect", {}),
  serviceInstall: () => invoke("omp:service:install", {}),
  serviceStart: () => invoke("omp:service:start", {}),
  serviceStop: () => invoke("omp:service:stop", {}),
  serviceRestart: () => invoke("omp:service:restart", {}),
  serviceUninstall: () => invoke("omp:service:uninstall", {}),
  getUpdateState: () => invoke<"app:update:get-state", unknown>("app:update:get-state", {}).then(decodeDesktopUpdateState),
  checkForUpdate: () => invoke<"app:update:check", unknown>("app:update:check", {}).then(decodeDesktopUpdateState),
  downloadUpdate: () => invoke<"app:update:download", unknown>("app:update:download", {}).then(decodeDesktopUpdateState),
  restartToUpdate: () => invoke<"app:update:restart", unknown>("app:update:restart", {}).then(decodeDesktopUpdateState),
  updateRendererReady: () => invoke<"app:update:renderer-ready", unknown>("app:update:renderer-ready", {}).then(decodeDesktopUpdateRendererReadyResult),
  listTargets: () => invoke("omp:targets:list", {}),
  addTarget: (request) => invoke("omp:targets:add", request),
  removeTarget: (request) => invoke("omp:targets:remove", request),
  connectTarget: (request) => invoke("omp:connect", request),
  disconnectTarget: (request) => invoke("omp:disconnect", request),
  onServerFrame: (listener) => subscribe("omp:server-frame", listener),
  onConnectionState: (listener) => subscribe("omp:connection-state", listener),
  onRuntimeError: (listener) => subscribe("omp:runtime-error", listener),
  onPairLink: (listener) => subscribe("omp:pair-link", listener),
  onUpdateState: (listener) => subscribe("app:update:state", listener),
  onOpenUpdateSettings: (listener) => subscribe("app:update:open", listener),
};

contextBridge.exposeInMainWorld("ompShell", bridge);
