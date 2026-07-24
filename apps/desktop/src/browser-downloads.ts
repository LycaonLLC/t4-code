import { app, type DownloadItem, type Session, type WebContents } from "electron";
import { link, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserDownload, BrowserEvent, SurfaceId } from "@t4-code/protocol/browser-ipc";

const MAX_DOWNLOAD_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_FILENAME_BYTES = 255;
const DEFAULT_WAIT_MS = 120_000;

export interface BrowserDownloadControllerOptions {
  readonly emit: (event: BrowserEvent) => void;
  /** Override Electron's Downloads directory in tests or an embedding host. */
  readonly downloadsPath?: string;
}

interface Waiter {
  readonly resolve: (download: BrowserDownload | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

interface AttachedSurface {
  readonly session: Session;
  readonly surfaceId: SurfaceId;
}

type DownloadListener = (event: Electron.Event, item: DownloadItem, webContents: WebContents) => void;

const TERMINAL_STATES = new Set<BrowserDownload["state"]>(["completed", "cancelled", "failed"]);
function stripAsciiControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    result += codePoint !== undefined && (codePoint <= 0x1F || codePoint === 0x7F) ? "" : character;
  }
  return result;
}

/**
 * Returns a bounded, filesystem-safe filename. A path-like suggestion is not
 * normalized: it is rejected and replaced so a hostile suggestion can never
 * escape Downloads.
 */
export function safeDownloadFilename(suggested: unknown, mimeType?: unknown, sourceUrl?: unknown): string {
  const candidate = typeof suggested === "string" ? suggested.normalize("NFKC").trim() : "";
  const pathLike = candidate.length === 0 || candidate === "." || candidate === ".." || candidate.includes("/") || candidate.includes("\\") || candidate.includes("\0") || candidate.split(/[\\/]/u).some((part) => part === "..") || /^[.]{2}(?:$|[.])/u.test(candidate);
  let filename = pathLike ? "download" : candidate;
  filename = stripAsciiControlCharacters(filename).replace(/[<>:"|?*]/gu, "_").trim();
  if (filename.length === 0 || filename === "." || filename === "..") filename = "download";

  const mime = typeof mimeType === "string" ? (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase() : "";
  const urlExtension = extensionFromUrl(sourceUrl);
  const mimeExtension = mimeExtensionFor(mime);
  if (mime === "application/pdf") {
    filename = `${withoutExtension(filename)}.pdf`;
  } else if (!hasExtension(filename)) {
    const extension = mimeExtension ?? urlExtension;
    if (extension !== undefined) filename += extension;
  }

  const bytes = Buffer.byteLength(filename, "utf8");
  if (bytes > MAX_FILENAME_BYTES) {
    const extension = extensionOf(filename) ?? "";
    const suffixBytes = Buffer.byteLength(extension, "utf8");
    const room = Math.max(1, MAX_FILENAME_BYTES - suffixBytes);
    filename = Buffer.from(filename, "utf8").subarray(0, room).toString("utf8").replace(/[\uDC00-\uDFFF]/gu, "") + extension;
  }
  return filename || "download";
}

function extensionOf(value: string): string | undefined {
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(index) : undefined;
}

function withoutExtension(value: string): string {
  const extension = extensionOf(value);
  return extension === undefined ? value : value.slice(0, -extension.length);
}

function hasExtension(value: string): boolean {
  return extensionOf(value) !== undefined;
}

function extensionFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const path = new URL(value).pathname;
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const extension = extensionOf(leaf);
    return extension !== undefined && /^[.][a-z0-9]{1,12}$/iu.test(extension) ? extension.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function mimeExtensionFor(mime: string): string | undefined {
  const extensions: Record<string, string> = {
    "application/gzip": ".gz",
    "application/json": ".json",
    "application/zip": ".zip",
    "audio/mpeg": ".mp3",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/css": ".css",
    "text/csv": ".csv",
    "text/html": ".html",
    "text/plain": ".txt",
    "video/mp4": ".mp4",
  };
  return extensions[mime];
}

function boundedBytes(value: unknown, fallback?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), MAX_DOWNLOAD_BYTES);
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 1_024);
  return "Download failed";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

/** Owns Electron will-download listeners and the files they produce. */
export class BrowserDownloadController {
  private readonly emitEvent: (event: BrowserEvent) => void;
  private readonly downloadsPath: string | undefined;
  private readonly surfaces = new Map<WebContents, AttachedSurface>();
  private readonly sessionListeners = new Map<Session, DownloadListener>();
  private readonly records = new Map<string, BrowserDownload>();
  private readonly items = new Map<string, DownloadItem>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private disposed = false;

  public constructor(options: BrowserDownloadControllerOptions) {
    this.emitEvent = options.emit;
    this.downloadsPath = options.downloadsPath;
  }

  public attach(webContents: WebContents, surfaceId: SurfaceId, session: Session): void {
    if (this.disposed) return;
    this.surfaces.set(webContents, { session, surfaceId });
    if (this.sessionListeners.has(session)) return;
    const listener: DownloadListener = (event, item, contents) => this.onWillDownload(session, event, item, contents);
    session.on("will-download", listener);
    this.sessionListeners.set(session, listener);
  }

  public list(surfaceId?: SurfaceId): readonly BrowserDownload[] {
    const values = [...this.records.values()].filter((record) => surfaceId === undefined || record.surfaceId === surfaceId);
    return Object.freeze(values);
  }

  public wait(downloadId: string, timeoutMs = DEFAULT_WAIT_MS): Promise<BrowserDownload | undefined> {
    const current = this.records.get(downloadId);
    if (current !== undefined && TERMINAL_STATES.has(current.state)) return Promise.resolve(current);
    if (this.disposed) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<BrowserDownload | undefined>();
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        const pending = this.waiters.get(downloadId);
        pending?.delete(waiter);
        if (pending?.size === 0) this.waiters.delete(downloadId);
        resolve(undefined);
      }, Math.max(0, Math.min(timeoutMs, DEFAULT_WAIT_MS))),
    };
    const pending = this.waiters.get(downloadId) ?? new Set<Waiter>();
    pending.add(waiter);
    this.waiters.set(downloadId, pending);
    return promise;
  }

  public cancel(downloadId: string): boolean {
    const item = this.items.get(downloadId);
    if (item === undefined) return false;
    try {
      item.cancel();
    } catch {
      // The terminal done event still performs cleanup and records failure.
    }
    return true;
  }

  public disposeSurface(surfaceId: SurfaceId): void {
    for (const [webContents, attached] of this.surfaces) {
      if (attached.surfaceId === surfaceId) this.surfaces.delete(webContents);
    }
    for (const [downloadId, record] of this.records) {
      if (record.surfaceId === surfaceId && !TERMINAL_STATES.has(record.state)) this.cancel(downloadId);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [session, listener] of this.sessionListeners) session.removeListener("will-download", listener);
    this.sessionListeners.clear();
    for (const downloadId of this.items.keys()) this.cancel(downloadId);
    this.surfaces.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
    }
    this.waiters.clear();
    await Promise.all([...this.records.values()].filter((record) => !TERMINAL_STATES.has(record.state)).map(async (record) => {
      await this.removeTemporaryFile(record.downloadId);
    }));
  }

  private onWillDownload(session: Session, event: Electron.Event, item: DownloadItem, webContents: WebContents): void {
    const attached = this.surfaces.get(webContents);
    if (attached === undefined || attached.session !== session || this.disposed) {
      event.preventDefault();
      return;
    }
    this.startDownload(item, attached.surfaceId);
  }

  private startDownload(item: DownloadItem, surfaceId: SurfaceId): void {
    const downloadId = crypto.randomUUID();
    const url = item.getURL();
    const mimeType = item.getMimeType() || undefined;
    const filename = safeDownloadFilename(item.getFilename(), mimeType, url);
    const totalBytes = boundedBytes(item.getTotalBytes());
    const started: BrowserDownload = Object.freeze({ downloadId, surfaceId, state: "started", url, filename, ...(mimeType === undefined ? {} : { mimeType }), ...(totalBytes === undefined ? {} : { totalBytes }), receivedBytes: 0 });
    this.records.set(downloadId, started);
    this.items.set(downloadId, item);
    try {
      const downloadsPath = this.resolveDownloadsPath();
      const temporaryPath = join(downloadsPath, `.t4-download-${downloadId}.part`);
      // Electron only permits setSavePath from inside the synchronous
      // will-download callback. Calling preventDefault cancels the item.
      item.setSavePath(temporaryPath);
      item.on("updated", (_event, state) => this.onUpdated(downloadId, state));
      item.once("done", (_event, state) => void this.onDone(downloadId, state, temporaryPath));
      this.publish(started);
      if (this.disposed) this.cancel(downloadId);
    } catch (error) {
      void this.failDownload(downloadId, error);
    }
  }

  private onUpdated(downloadId: string, _state: string): void {
    const current = this.records.get(downloadId);
    if (this.disposed || current === undefined || TERMINAL_STATES.has(current.state)) return;
    const receivedBytes = boundedBytes(this.items.get(downloadId)?.getReceivedBytes(), current.receivedBytes ?? 0);
    const next: BrowserDownload = Object.freeze({ ...current, state: "progress", ...(receivedBytes === undefined ? {} : { receivedBytes }) });
    this.records.set(downloadId, next);
    this.publish(next);
  }

  private async onDone(downloadId: string, state: string, temporaryPath: string): Promise<void> {
    if (this.disposed) {
      await this.removeFile(temporaryPath);
      this.items.delete(downloadId);
      return;
    }
    const current = this.records.get(downloadId);
    if (current === undefined || TERMINAL_STATES.has(current.state)) return;
    const receivedBytes = boundedBytes(this.items.get(downloadId)?.getReceivedBytes(), current.receivedBytes ?? 0);
    if (state === "completed") {
      try {
        const savePath = await this.commitTemporaryFile(temporaryPath, current.filename);
        const completed: BrowserDownload = Object.freeze({ ...current, state: "completed", ...(receivedBytes === undefined ? {} : { receivedBytes }) });
        this.records.set(downloadId, completed);
        this.items.delete(downloadId);
        this.publish(completed);
        this.resolveWaiters(downloadId, completed);
        // Keep the path private to the controller; it must not enter BrowserEvent.
        void savePath;
      } catch (error) {
        await this.failDownload(downloadId, error, temporaryPath);
      }
      return;
    }
    await this.removeFile(temporaryPath);
    const terminalState: BrowserDownload["state"] = state === "cancelled" ? "cancelled" : "failed";
    const terminal: BrowserDownload = Object.freeze({ ...current, state: terminalState, ...(receivedBytes === undefined ? {} : { receivedBytes }), ...(terminalState === "failed" ? { failure: state || "Download failed" } : {}) });
    this.records.set(downloadId, terminal);
    this.items.delete(downloadId);
    this.publish(terminal);
    this.resolveWaiters(downloadId, terminal);
  }

  private async failDownload(downloadId: string, error: unknown, temporaryPath?: string): Promise<void> {
    if (temporaryPath !== undefined) await this.removeFile(temporaryPath);
    const current = this.records.get(downloadId);
    if (current === undefined || TERMINAL_STATES.has(current.state)) return;
    const failed: BrowserDownload = Object.freeze({ ...current, state: "failed", failure: errorText(error) });
    this.records.set(downloadId, failed);
    this.items.delete(downloadId);
    this.publish(failed);
    this.resolveWaiters(downloadId, failed);
  }

  private publish(download: BrowserDownload): void {
    try {
      this.emitEvent({ type: "download", download });
    } catch {
      // Event consumers must not be able to interrupt download cleanup.
    }
  }

  private resolveWaiters(downloadId: string, result: BrowserDownload): void {
    const pending = this.waiters.get(downloadId);
    if (pending === undefined) return;
    this.waiters.delete(downloadId);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  private resolveDownloadsPath(): string {
    if (this.downloadsPath !== undefined) return this.downloadsPath;
    try {
      return app.getPath("downloads");
    } catch {
      return join(app.getPath("userData"), "Downloads");
    }
  }

  private async commitTemporaryFile(temporaryPath: string, filename: string): Promise<string> {
    const directory = dirname(temporaryPath);
    const extension = extensionOf(filename) ?? "";
    const base = withoutExtension(filename);
    for (let index = 0; index < 10_000; index += 1) {
      const suffix = index === 0 ? "" : ` (${index})`;
      const destination = join(directory, `${base}${suffix}${extension}`);
      try {
        await link(temporaryPath, destination);
        await unlink(temporaryPath);
        return destination;
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
    throw new Error("Unable to allocate a unique download filename");
  }

  private async removeFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOENT") return;
    }
  }

  private async removeTemporaryFile(downloadId: string): Promise<void> {
    const directory = this.resolveDownloadsPath();
    const prefix = `.t4-download-${downloadId}.part`;
    try {
      const names = await readdir(directory);
      await Promise.all(names.filter((name) => name === prefix).map((name) => this.removeFile(join(directory, name))));
    } catch {
      // Downloads may not have been created yet.
    }
  }
}
