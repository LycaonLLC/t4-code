import { dialog, type BrowserWindow, type MessageBoxOptions, type OpenDialogOptions, type Session, type WebContents } from "electron";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SurfaceId } from "@t4-code/protocol/browser-ipc";

const MAX_QUEUE = 32;
const DEFAULT_PROJECT_ROOT = process.cwd();

export interface BrowserDialogControllerOptions {
  readonly window?: BrowserWindow;
  readonly session?: Session;
  readonly projectRoot?: string;
  readonly maxQueue?: number;
  readonly nativeDialog?: NativeBrowserDialog;
}

export type NativeBrowserDialog = Pick<typeof dialog, "showOpenDialog" | "showMessageBox">;

export interface BrowserFileChooserOptions {
  readonly multiple?: boolean;
  readonly directory?: boolean;
  readonly projectRoot?: string;
  readonly allowOutsideProject?: boolean;
}

export interface BrowserJavaScriptDialogResult {
  readonly accepted: boolean;
  readonly value?: string;
}

export interface BrowserJavaScriptDialogOptions {
  readonly kind: "alert" | "confirm" | "prompt";
  readonly message: string;
  readonly defaultValue?: string;
  readonly title?: string;
}

interface HookableWebContents {
  on(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

interface DialogJob {
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly fallback: unknown;
  settled: boolean;
}

interface SurfaceQueue {
  readonly webContents: WebContents;
  readonly jobs: DialogJob[];
  readonly listeners: Array<{ event: string; listener: (...args: unknown[]) => void }>;
  active: DialogJob | undefined;
  disposed: boolean;
  draining: boolean;
}

const defaultNativeDialog: NativeBrowserDialog = dialog;

/** Coordinates native file and JavaScript/permission dialogs per browser surface. */
export class BrowserDialogController {
  private readonly window: BrowserWindow | undefined;
  private readonly projectRoot: string;
  private readonly maxQueue: number;
  private readonly nativeDialog: NativeBrowserDialog;
  private readonly surfaces = new Map<SurfaceId, SurfaceQueue>();
  private disposed = false;

  public constructor(options: BrowserDialogControllerOptions) {
    this.window = options.window;
    this.projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
    this.maxQueue = Math.max(1, Math.min(options.maxQueue ?? MAX_QUEUE, MAX_QUEUE));
    this.nativeDialog = options.nativeDialog ?? defaultNativeDialog;
  }

  /** Install event hooks when an embedding WebContents supports them. */
  public install(webContents: WebContents, surfaceId: SurfaceId): void {
    if (this.disposed) return;
    this.disposeSurface(surfaceId);
    const queue: SurfaceQueue = { webContents, jobs: [], listeners: [], active: undefined, disposed: false, draining: false };
    this.surfaces.set(surfaceId, queue);
    const hooks = webContents as unknown as HookableWebContents;

    const fileListener = (...args: unknown[]): void => {
      const event = args[0];
      if (isPreventable(event)) event.preventDefault();
      const request = isRecord(args[1]) ? args[1] : isRecord(args[0]) ? args[0] : {};
      const callback = readCallback(args[1]) ?? readCallback(args[2]) ?? readCallback(request.callback);
      void this.handleFileChooser(surfaceId, request as BrowserFileChooserOptions).then((paths) => callback?.(paths));
    };
    const dialogListener = (...args: unknown[]): void => {
      const event = args[0];
      if (isPreventable(event)) event.preventDefault();
      const request = isRecord(args[1]) ? args[1] : {};
      const callback = readCallback(args[2]) ?? readCallback(request.callback);
      const kind = request.kind === "confirm" || request.kind === "prompt" ? request.kind : "alert";
      void this.handleJavaScriptDialog(surfaceId, {
        kind,
        message: typeof request.message === "string" ? request.message : "",
        ...(typeof request.defaultValue === "string" ? { defaultValue: request.defaultValue } : {}),
        ...(typeof request.title === "string" ? { title: request.title } : {}),
      }).then((result) => callback?.(result));
    };
    const permissionListener = (...args: unknown[]): void => {
      const callback = readCallback(args[2]) ?? readCallback(args[3]);
      const permission = typeof args[1] === "string" ? args[1] : "unknown";
      void this.handlePermissionRequest(surfaceId, permission).then((allowed) => callback?.(allowed));
    };

    for (const [event, listener] of [["select-file", fileListener], ["javascript-dialog", dialogListener], ["permission-request", permissionListener]] as const) {
      hooks.on(event, listener);
      queue.listeners.push({ event, listener });
    }
  }

  public async handleFileChooser(surfaceId: SurfaceId, options: BrowserFileChooserOptions = {}): Promise<readonly string[]> {
    const queue = this.surfaces.get(surfaceId);
    if (queue === undefined || queue.disposed || this.disposed) return [];
    return this.enqueue(queue, async () => {
      const directory = options.directory === true;
      const properties: NonNullable<OpenDialogOptions["properties"]> = directory
        ? ["openDirectory", "createDirectory"]
        : ["openFile", ...(options.multiple === true ? ["multiSelections" as const] : [])];
      const openDialogOptions: OpenDialogOptions = {
        title: directory ? "Choose a directory" : "Choose files to upload",
        defaultPath: options.projectRoot ?? this.projectRoot,
        properties,
      };
      const selected = this.window === undefined
        ? await this.nativeDialog.showOpenDialog(openDialogOptions)
        : await this.nativeDialog.showOpenDialog(this.window, openDialogOptions);
      if (selected.canceled) return [];
      const root = resolve(options.projectRoot ?? this.projectRoot);
      const paths: string[] = [];
      for (const selectedPath of selected.filePaths.slice(0, options.multiple === true && !directory ? 64 : 1)) {
        const checked = await this.confinedPath(selectedPath, root, directory, options.allowOutsideProject === true);
        if (checked !== undefined) paths.push(checked);
      }
      return paths;
    }, []);
  }

  public handleJavaScriptDialog(surfaceId: SurfaceId, options: BrowserJavaScriptDialogOptions): Promise<BrowserJavaScriptDialogResult> {
    const queue = this.surfaces.get(surfaceId);
    if (queue === undefined || queue.disposed || this.disposed) return Promise.resolve({ accepted: false });
    return this.enqueue(queue, async () => {
      const message = options.message.slice(0, 16_384);
      const buttons = options.kind === "alert" ? ["OK"] : ["OK", "Cancel"];
      const box: MessageBoxOptions = {
        type: options.kind === "alert" ? "info" : "question",
        title: options.title?.slice(0, 512) ?? "Browser dialog",
        message,
        buttons,
        defaultId: 0,
        cancelId: options.kind === "alert" ? 0 : 1,
        ...(options.kind === "prompt" && options.defaultValue !== undefined ? { detail: `Default value: ${options.defaultValue.slice(0, 4_096)}` } : {}),
      };
      const result = this.window === undefined
        ? await this.nativeDialog.showMessageBox(box)
        : await this.nativeDialog.showMessageBox(this.window, box);
      const accepted = result.response === 0;
      return options.kind === "prompt" ? { accepted, ...(accepted ? { value: options.defaultValue ?? "" } : {}) } : { accepted };
    }, { accepted: false });
  }

  public handlePermissionRequest(surfaceId: SurfaceId, permission: string, origin?: string): Promise<boolean> {
    const queue = this.surfaces.get(surfaceId);
    if (queue === undefined || queue.disposed || this.disposed) return Promise.resolve(false);
    return this.enqueue(queue, async () => {
      const result = this.window === undefined
        ? await this.nativeDialog.showMessageBox({
            type: "question",
            title: "Browser permission request",
            message: `Allow ${permission} permission?`,
            ...(origin === undefined ? {} : { detail: origin.slice(0, 2_048) }),
            buttons: ["Allow", "Deny"],
            defaultId: 1,
            cancelId: 1,
          })
        : await this.nativeDialog.showMessageBox(this.window, {
            type: "question",
            title: "Browser permission request",
            message: `Allow ${permission} permission?`,
            ...(origin === undefined ? {} : { detail: origin.slice(0, 2_048) }),
            buttons: ["Allow", "Deny"],
            defaultId: 1,
            cancelId: 1,
          });
      return result.response === 0;
    }, false);
  }

  public disposeSurface(surfaceId: SurfaceId): void {
    const queue = this.surfaces.get(surfaceId);
    if (queue === undefined) return;
    queue.disposed = true;
    const hooks = queue.webContents as unknown as HookableWebContents;
    for (const { event, listener } of queue.listeners) hooks.removeListener(event, listener);
    queue.listeners.length = 0;
    for (const job of queue.jobs.splice(0)) {
      job.settled = true;
      job.resolve(job.fallback);
    }
    if (queue.active !== undefined) {
      queue.active.settled = true;
      queue.active.resolve(queue.active.fallback);
    }
    this.surfaces.delete(surfaceId);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const surfaceId of this.surfaces.keys()) this.disposeSurface(surfaceId);
  }

  private enqueue<T>(queue: SurfaceQueue, run: () => Promise<T>, fallback: T): Promise<T> {
    if (queue.disposed || this.disposed || queue.jobs.length >= this.maxQueue) return Promise.resolve(fallback);
    const { promise, resolve } = Promise.withResolvers<T>();
    const job: DialogJob = {
      run: async () => run(),
      resolve: (value) => resolve(value as T),
      fallback,
      settled: false,
    };
    queue.jobs.push(job);
    void this.drain(queue);
    return promise;
  }

  private async drain(queue: SurfaceQueue): Promise<void> {
    if (queue.draining) return;
    queue.draining = true;
    try {
      while (!queue.disposed) {
        const job = queue.jobs.shift();
        if (job === undefined) break;
        queue.active = job;
        try {
          const value = await job.run();
          if (!job.settled) {
            job.settled = true;
            job.resolve(value);
          }
        } catch {
          if (!job.settled) {
            job.settled = true;
            job.resolve(job.fallback);
          }
        } finally {
          queue.active = undefined;
        }
      }
    } finally {
      queue.draining = false;
    }
  }

  private async confinedPath(value: string, root: string, directory: boolean, allowOutside: boolean): Promise<string | undefined> {
    const candidate = resolve(value);
    if (!isAbsolute(candidate)) return undefined;
    try {
      const canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (directory ? !info.isDirectory() : !info.isFile()) return undefined;
      if (allowOutside) return canonical;
      const rootCanonical = await realpath(root);
      const distance = relative(rootCanonical, canonical);
      if (distance === "" || (!distance.startsWith("..") && !isAbsolute(distance))) return canonical;
    } catch {
      return undefined;
    }
    return undefined;
  }
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPreventable(value: unknown): value is { preventDefault(): void } {
  return isRecord(value) && typeof value.preventDefault === "function";
}

function readCallback(value: unknown): ((value: unknown) => void) | undefined {
  return typeof value === "function" ? value as (value: unknown) => void : undefined;
}
