import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CursorStore } from "@t4-code/client";
import type { ServiceManager } from "@t4-code/service-manager";
import type { RemoteTargetRegistry } from "./remote-runtime/registry.ts";
import { createDesktopWindow, type DesktopWindowHandle } from "./window.ts";
import { DesktopIpcRegistry, runtimeError, type IpcRuntime } from "./ipc.ts";
import { ElectronCursorStore, ElectronRemoteTargetStore, ElectronCredentialCiphertextStore, electronSafeStorage, loadDeviceIdentity, type DeviceIdentity } from "./stores.ts";
import { VersionedRemoteTargetRegistry, DeviceCredentialStore } from "./remote-runtime/index.ts";
import { LocalTargetManager, type TargetManagerOptions } from "./target-manager.ts";
import { parsePairDeepLink, PendingPairQueue, type PendingPair } from "./deep-link.ts";
import { createAppserverServiceManager, discoverOmpExecutable, probeOmpAppserver, NodeServiceFileSystem } from "./service.ts";

export function appserverLogsDirectory(
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return join(homeDirectory, "Library", "Logs", "T4 Code", "appserver");
  const configuredStateRoot = environment.XDG_STATE_HOME;
  const stateRoot = configuredStateRoot?.startsWith("/") === true
    ? configuredStateRoot
    : join(homeDirectory, ".local", "state");
  return join(stateRoot, "t4-code", "appserver");
}

export interface DesktopLifecycleOptions {
  readonly app?: typeof app;
  readonly getAllWindows?: () => readonly BrowserWindow[];
  readonly createWindow?: () => DesktopWindowHandle;
  readonly createIpcRegistry?: (runtime: IpcRuntime) => DesktopIpcRegistry;
  readonly loadIdentity?: () => DeviceIdentity;
  readonly createCursorStore?: () => CursorStore;
  readonly createRemoteRegistry?: () => RemoteTargetRegistry;
  readonly createCredentials?: () => DeviceCredentialStore | undefined;
  readonly discoverExecutable?: () => Promise<string | undefined>;
  readonly probeAppserver?: (executable: string) => Promise<boolean>;
  readonly createServiceManager?: (options: Parameters<typeof createAppserverServiceManager>[0]) => ServiceManager;
  readonly createTargetManager?: (options: TargetManagerOptions) => LocalTargetManager;
}

export class DesktopLifecycle {
  private readonly pendingPairs = new PendingPairQueue(8);
  private readonly electronApp: typeof app;
  private readonly allWindows: () => readonly BrowserWindow[];
  private readonly windowFactory: () => DesktopWindowHandle;
  private readonly ipcFactory: (runtime: IpcRuntime) => DesktopIpcRegistry;
  private readonly identityFactory: () => DeviceIdentity;
  private readonly cursorStoreFactory: () => CursorStore;
  private readonly remoteRegistryFactory: () => RemoteTargetRegistry;
  private readonly credentialsFactory: () => DeviceCredentialStore | undefined;
  private readonly executableFactory: () => Promise<string | undefined>;
  private readonly serviceFactory: (options: Parameters<typeof createAppserverServiceManager>[0]) => ServiceManager;
  private readonly appserverProbe: (executable: string) => Promise<boolean>;
  private readonly targetManagerFactory: (options: TargetManagerOptions) => LocalTargetManager;
  private mainWindow: BrowserWindow | undefined;
  private ipc: DesktopIpcRegistry | undefined;
  private manager: LocalTargetManager | undefined;
  private serviceManager: ServiceManager | undefined;
  private rendererLoaded = false;
  private startupPromise: Promise<void> | undefined;
  private startupServiceError: unknown;
  private started = false;
  private stopping = false;
  private beforeQuitHandler: (() => void) | undefined;

  constructor(options: DesktopLifecycleOptions = {}) {
    this.electronApp = options.app ?? app;
    this.allWindows = options.getAllWindows ?? (() => BrowserWindow.getAllWindows());
    this.windowFactory = options.createWindow ?? createDesktopWindow;
    this.ipcFactory = options.createIpcRegistry ?? ((runtime) => new DesktopIpcRegistry(runtime));
    this.identityFactory = options.loadIdentity ?? (() => loadDeviceIdentity());
    this.cursorStoreFactory = options.createCursorStore ?? (() => new ElectronCursorStore());
    this.remoteRegistryFactory = options.createRemoteRegistry ?? (() => new VersionedRemoteTargetRegistry(new ElectronRemoteTargetStore()));
    this.credentialsFactory = options.createCredentials ?? (() => {
      if (!electronSafeStorage.isEncryptionAvailable()) return undefined;
      try { return new DeviceCredentialStore(new ElectronCredentialCiphertextStore(), electronSafeStorage); } catch { return undefined; }
    });
    this.executableFactory = options.discoverExecutable ?? (() => discoverOmpExecutable());
    this.appserverProbe = options.probeAppserver ?? ((executable) => probeOmpAppserver(executable));
    this.serviceFactory = options.createServiceManager ?? createAppserverServiceManager;
    this.targetManagerFactory = options.createTargetManager ?? ((managerOptions) => new LocalTargetManager(managerOptions));
  }
  async start(): Promise<void> {
    if (this.startupPromise !== undefined) return this.startupPromise;
    this.startupPromise = this.startInternal();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    const gotLock = this.electronApp.requestSingleInstanceLock();
    if (!gotLock) {
      this.electronApp.quit();
      return;
    }
    const ingest = (value: string): void => {
      const parsed = parsePairDeepLink(value);
      if (parsed === null) return;
      const pending: PendingPair = { hostHint: parsed.hostHint, code: parsed.code, issuedAt: parsed.issuedAt };
      if (this.rendererLoaded && this.mainWindow !== undefined && !this.mainWindow.isDestroyed()) this.ipc?.emitPairLink(pending);
      else this.pendingPairs.push(pending);
    };
    for (const argument of process.argv) ingest(argument);
    this.electronApp.on("second-instance", (_event, argv) => {
      for (const argument of argv) ingest(argument);
      this.mainWindow?.show();
      this.mainWindow?.focus();
    });
    this.electronApp.on("open-url", (event, value) => {
      event.preventDefault();
      ingest(value);
    });
    await this.electronApp.whenReady();
    if (process.platform === "darwin") this.electronApp.setAsDefaultProtocolClient("t4-code");
    const identity = this.identityFactory();
    const remoteRegistry = this.remoteRegistryFactory();
    const credentials = this.credentialsFactory();
    let executable: string | undefined;
    try {
      executable = await this.executableFactory();
    } catch (error) {
      this.startupServiceError = error;
    }
    if (executable !== undefined) {
      try {
        this.serviceManager = this.serviceFactory({
          homeDirectory: homedir(),
          logsDirectory: appserverLogsDirectory(homedir()),
          executable,
          argv: executable.endsWith("/ompd") ? [] : ["appserver", "serve"],
          fs: new NodeServiceFileSystem(),
        });
      } catch (error) {
        this.startupServiceError = error;
      }
    }
    if (this.serviceManager !== undefined) {
      try {
        // A healthy appserver may have been launched outside T4 Code. Use it
        // as-is; service installation/startup is only a cold-start fallback.
        // This keeps opening the desktop app read-only for an already-live
        // runtime while retaining the manager for later explicit actions.
        const alreadyReady = await this.appserverProbe(executable ?? "").catch(() => false);
        if (!alreadyReady) await this.ensureServiceReady(this.serviceManager, executable ?? "");
      } catch (error) {
        this.startupServiceError = error;
      }
    }
    this.manager = this.targetManagerFactory({
      cursorStore: this.cursorStoreFactory(),
      registry: remoteRegistry,
      ...(credentials === undefined ? {} : { credentials }),
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      events: {
        onFrame: (targetId, frame) => this.ipc?.emitServerFrame(targetId, frame),
        onState: (state) => this.ipc?.emitConnectionState(state),
        onError: (error) => this.ipc?.emitRuntimeError(error),
      },
    });
    this.bindWindow(this.windowFactory());
    this.beforeQuitHandler = () => {
      if (this.stopping) return;
      this.stopping = true;
      void this.manager?.close().catch((error: unknown) => this.ipc?.emitRuntimeError(runtimeError(error, "local")));
    };
    this.electronApp.on("before-quit", this.beforeQuitHandler);
    this.electronApp.on("activate", () => {
      if (this.stopping) return;
      if (this.allWindows().length === 0) this.bindWindow(this.windowFactory());
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.ipc?.uninstall();
    this.ipc = undefined;
    this.mainWindow = undefined;
    const manager = this.manager;
    this.manager = undefined;
    if (manager !== undefined) await manager.close();
    if (this.beforeQuitHandler !== undefined) this.electronApp.removeListener("before-quit", this.beforeQuitHandler);
    this.beforeQuitHandler = undefined;
  }
  private async ensureServiceReady(manager: ServiceManager, executable: string): Promise<void> {
    let inspection = await manager.inspect();
    if (inspection.definition !== "current") {
      await manager.install();
      inspection = await manager.inspect();
    }
    if (inspection.service !== "running") await manager.start();
    const deadline = Date.now() + 5_000;
    while (true) {
      inspection = await manager.inspect();
      if (inspection.service === "running" && await this.appserverProbe(executable)) return;
      if (Date.now() >= deadline) throw new Error(`appserver service did not become ready (${inspection.diagnostics.slice(0, 512)})`);
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 100);
      await delay.promise;
    }
  }

  private bindWindow(handle: DesktopWindowHandle): void {
    this.rendererLoaded = false;
    const manager = this.manager;
    if (manager === undefined) return;
    this.mainWindow = handle.window;
    this.ipc?.uninstall();
    const serviceUnavailableReason =
      this.serviceManager === undefined && this.startupServiceError !== undefined
        ? runtimeError(this.startupServiceError).message
        : undefined;
    this.ipc = this.ipcFactory({
      manager,
      window: handle.window,
      trustedRenderer: handle.trustedRenderer,
      ...(this.serviceManager === undefined ? {} : { serviceManager: this.serviceManager }),
      ...(serviceUnavailableReason === undefined ? {} : { serviceUnavailableReason }),
      drainPairLinks: () => this.pendingPairs.drain(),
    });
    this.ipc.install();
    handle.window.webContents.once("did-finish-load", () => {
      this.rendererLoaded = true;
      if (this.startupServiceError !== undefined) {
        this.ipc?.emitRuntimeError(runtimeError(this.startupServiceError, "local"));
        this.startupServiceError = undefined;
      }
      const links = this.pendingPairs.drain();
      for (const link of links) this.ipc?.emitPairLink(link);
    });
    handle.window.on("closed", () => {
      if (this.mainWindow === handle.window) {
        this.mainWindow = undefined;
        this.rendererLoaded = false;
        this.ipc?.uninstall();
        this.ipc = undefined;
      }
    });
  }
}
