import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  decodeDesktopEvent,
  decodeDesktopInvokeRequest,
  type BootstrapResult,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type ConnectionStateEvent,
  type ConnectResult,
  type DesktopEventChannel,
  type DesktopInvokeChannel,
  type DesktopInvokeRequest,
  type DisconnectResult,
  type PairLinkEvent,
  type PairRequest,
  type PairResult,
  type PairLinksDrainResult,
  type RuntimeErrorEvent,
  type ServiceActionResult,
  type ServiceInspection,
  type TargetAddRequest,
  type TargetListResult,
  type TargetRemoveResult,
  type TargetRequest,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalResult,
} from "@t4-code/protocol/desktop-ipc";
import type { RendererServerFrame } from "@t4-code/protocol/desktop-ipc";
import type { ServiceManager } from "@t4-code/service-manager";
import { trustedSender, type TrustedRenderer } from "./security.ts";
import type { LocalTargetManager } from "./target-manager.ts";
export interface IpcRuntime {
  readonly manager: LocalTargetManager;
  readonly window: BrowserWindow;
  readonly trustedRenderer: TrustedRenderer;
  readonly serviceManager?: ServiceManager;
  /** Safe, user-facing reason service management could not be created. */
  readonly serviceUnavailableReason?: string;
  readonly drainPairLinks?: () => readonly PairLinkEvent[];
}
export class RemotePairingUnavailableError extends Error {
  readonly code = "remote_pairing_unavailable" as const;
  constructor() {
    super("Remote pairing is not available in this desktop build.");
    this.name = "RemotePairingUnavailableError";
    Object.defineProperty(this, "stack", { value: undefined, enumerable: false, configurable: true });
  }
}
export function validEvent(event: IpcMainInvokeEvent, runtime: IpcRuntime): boolean {
  return trustedSender(event.sender, runtime.window, runtime.trustedRenderer, event.senderFrame);
}

function boundedError(error: unknown): { readonly code: RuntimeErrorEvent["code"]; readonly message: string } {
  const message = error instanceof Error ? error.message : "Desktop operation failed";
  const safe = message
    .replace(/https?:\/\/[^\s]+/giu, "[redacted]")
    .replace(/\b(?:token|secret|password|credential|authorization)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/(?:^|\s)(?:\/(?:home|tmp|var|etc|opt|srv|mnt|run)\/[^\s,;]*)/gu, " [redacted]")
    // Control-code sanitization intentionally covers C0/C1 controls.
    .replace(new RegExp("[\\u0000-\\u001f\\u007f]", "gu"), " "); // oxlint-disable-line no-control-regex -- security redaction boundary
  return { code: "internal", message: safe.slice(0, 2048) };
}
function decodeRequest(channel: DesktopInvokeChannel, value: unknown): DesktopInvokeRequest {
  const request = decodeDesktopInvokeRequest(value);
  if (request.channel !== channel) throw new Error("channel mismatch");
  return request;
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}
export class DesktopIpcRegistry {
  private installed = false;
  private readonly runtime: IpcRuntime;
  private readonly serviceQueue = { tail: Promise.resolve() };
  private readonly ipc: IpcMainLike;
  constructor(runtime: IpcRuntime, ipc: IpcMainLike = ipcMain) {
    this.runtime = runtime;
    this.ipc = ipc;
  }

  install(): void {
    this.uninstall();
    this.installed = true;
    this.ipc.handle("omp:bootstrap", async (event, payload: unknown): Promise<BootstrapResult> => {
      this.assertSender(event);
      decodeRequest("omp:bootstrap", payload);
      const service = this.runtime.serviceManager === undefined ? undefined : await this.inspectService();
      return { platform: process.platform === "darwin" ? "darwin" : "linux", version: "omp-app/1", connected: this.runtime.manager.isConnected(), ...(service === undefined ? {} : { service }) };
    });
    this.ipc.handle("omp:connect", async (event, payload: unknown): Promise<ConnectResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:connect", payload).payload as TargetRequest;
      const state = await this.runtime.manager.connect(input.targetId);
      return { targetId: input.targetId, state };
    });
    this.ipc.handle("omp:disconnect", async (event, payload: unknown): Promise<DisconnectResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:disconnect", payload).payload as TargetRequest;
      await this.runtime.manager.disconnect(input.targetId);
      return { targetId: input.targetId, state: "disconnected" };
    });
    this.ipc.handle("omp:confirm", async (event, payload: unknown): Promise<ConfirmResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:confirm", payload).payload as ConfirmRequest;
      return this.runtime.manager.confirm(input);
    });
    this.ipc.handle("omp:terminal:input", async (event, payload: unknown): Promise<TerminalResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:terminal:input", payload).payload as TerminalInputRequest;
      return this.runtime.manager.terminalInput(input);
    });
    this.ipc.handle("omp:terminal:resize", async (event, payload: unknown): Promise<TerminalResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:terminal:resize", payload).payload as TerminalResizeRequest;
      return this.runtime.manager.terminalResize(input);
    });
    this.ipc.handle("omp:terminal:close", async (event, payload: unknown): Promise<TerminalResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:terminal:close", payload).payload as TerminalCloseRequest;
      return this.runtime.manager.terminalClose(input);
    });
    this.ipc.handle("omp:command", async (event, payload: unknown): Promise<CommandResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:command", payload).payload as CommandRequest;
      return this.runtime.manager.command(input.targetId, input.intent);
    });
    this.ipc.handle("omp:pair", async (event, payload: unknown): Promise<PairResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:pair", payload).payload as PairRequest;
      return this.runtime.manager.pairStart(input.targetId, input.code);
    });
    this.ipc.handle("omp:pair-links:drain", async (event, payload: unknown): Promise<PairLinksDrainResult> => {
      this.assertSender(event);
      decodeRequest("omp:pair-links:drain", payload);
      return { links: Object.freeze([...(this.runtime.drainPairLinks?.() ?? [])]) };
    });
    this.ipc.handle("omp:targets:list", async (event, payload: unknown): Promise<TargetListResult> => {
      this.assertSender(event);
      decodeRequest("omp:targets:list", payload);
      return { targets: await this.runtime.manager.listTargets() };
    });
    this.ipc.handle("omp:targets:add", async (event, payload: unknown): Promise<{ target: unknown }> => {
      this.assertSender(event);
      const input = decodeRequest("omp:targets:add", payload).payload as TargetAddRequest;
      return { target: await this.runtime.manager.addRemoteTarget(input.target) };
    });
    this.ipc.handle("omp:targets:remove", async (event, payload: unknown): Promise<TargetRemoveResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:targets:remove", payload).payload as TargetRequest;
      await this.runtime.manager.removeTarget(input.targetId);
      return { targetId: input.targetId, removed: true };
    });
    this.ipc.handle("omp:service:inspect", async (event, payload: unknown): Promise<ServiceInspection> => {
      this.assertSender(event);
      decodeRequest("omp:service:inspect", payload);
      return this.inspectService();
    });
    for (const action of ["install", "start", "stop", "restart", "uninstall"] as const) {
      this.ipc.handle(`omp:service:${action}`, async (event, payload: unknown): Promise<ServiceActionResult> => {
        this.assertSender(event);
        decodeRequest(`omp:service:${action}`, payload);
        await this.runServiceAction(action);
        return { completed: true };
      });
    }
  }
  uninstall(): void {
    for (const channel of [
      "omp:bootstrap", "omp:connect", "omp:disconnect", "omp:command", "omp:confirm",
      "omp:terminal:input", "omp:terminal:resize", "omp:terminal:close", "omp:pair",
      "omp:pair-links:drain", "omp:targets:list", "omp:targets:add", "omp:targets:remove",
      "omp:service:inspect", "omp:service:install", "omp:service:start", "omp:service:stop",
      "omp:service:restart", "omp:service:uninstall",
    ] as const) this.ipc.removeHandler(channel);
    this.installed = false;
  }
  emitServerFrame(targetId: string, frame: RendererServerFrame): void {
    this.emit("omp:server-frame", { targetId, frame });
  }
  emitConnectionState(event: ConnectionStateEvent): void {
    this.emit("omp:connection-state", event);
  }
  emitRuntimeError(event: RuntimeErrorEvent): void {
    this.emit("omp:runtime-error", event);
  }
  emitPairLink(event: PairLinkEvent): void {
    this.emit("omp:pair-link", event);
  }

  private assertSender(event: IpcMainInvokeEvent): void {
    if (!validEvent(event, this.runtime)) throw new Error("untrusted desktop sender");
  }
  private inspectService(): Promise<ServiceInspection> {
    const manager = this.runtime.serviceManager;
    if (manager === undefined) throw new Error(this.runtime.serviceUnavailableReason ?? "appserver service is unavailable");
    const result = manager.inspect();
    return result.then((inspection) => {
      if (!["missing", "current", "drifted"].includes(inspection.definition) || !["stopped", "starting", "running", "failed", "unknown"].includes(inspection.service) || typeof inspection.diagnostics !== "string") throw new Error("invalid service inspection");
      return { definition: inspection.definition, service: inspection.service, diagnostics: boundedError(new Error(inspection.diagnostics)).message.slice(0, 512) };
    });
  }
  private runServiceAction(action: "install" | "start" | "stop" | "restart" | "uninstall"): Promise<void> {
    const manager = this.runtime.serviceManager;
    if (manager === undefined) return Promise.reject(new Error(this.runtime.serviceUnavailableReason ?? "appserver service is unavailable"));
    const operation = () => manager[action]();
    const result = this.serviceQueue.tail.then(operation, operation);
    this.serviceQueue.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private emit(channel: DesktopEventChannel, payload: unknown): void {
    const decoded = decodeDesktopEvent({ channel, payload });
    if (this.runtime.window.isDestroyed() || this.runtime.window.webContents.isDestroyed()) return;
    this.runtime.window.webContents.send(channel, decoded.payload);
  }
}

export function runtimeError(error: unknown, targetId?: string): RuntimeErrorEvent {
  const safe = boundedError(error);
  return { ...(targetId === undefined ? {} : { targetId }), code: safe.code, message: safe.message };
}

void runtimeError;
