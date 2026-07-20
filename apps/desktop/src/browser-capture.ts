import { contentTracing, type Rectangle } from "electron";
import type { Parameters as ElectronDeviceEmulationParameters } from "electron";
import type { BrowserErrorCode, BrowserJsonValue } from "@t4-code/protocol/browser-ipc";

const MAX_VIEWPORT = 4_096;
const DEFAULT_VIEWPORT = { width: 1_280, height: 720 } as const;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_COUNT = 120;
const MAX_TRACE_CATEGORIES = 64;
const MAX_TRACE_CATEGORY_LENGTH = 128;
const MAX_TRACE_PATH_LENGTH = 4_096;

export interface BrowserNativeImageLike {
  toPNG(): Uint8Array;
  getSize?(): { readonly width: number; readonly height: number };
}

export interface BrowserCaptureContents {
  capturePage(rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Promise<BrowserNativeImageLike> | BrowserNativeImageLike;
  enableDeviceEmulation?(parameters: ElectronDeviceEmulationParameters): void;
  disableDeviceEmulation?(): void;
  setZoomFactor?(factor: number): void;
  getZoomFactor?(): number;
  focus?(): void;
  isFocused?(): boolean;
  beginFrameSubscription?: {
    (onlyDirty: boolean, callback: (image: BrowserNativeImageLike, dirtyRect: Rectangle) => void): void;
    (callback: (image: BrowserNativeImageLike, dirtyRect: Rectangle) => void): void;
  };
  endFrameSubscription?(): void;
}

export interface BrowserCaptureSurface {
  readonly webContents?: BrowserCaptureContents | null;
  readonly surfaceId?: string;
  readonly state?: unknown;
  readonly snapshot?: () => unknown | Promise<unknown>;
  readonly getSnapshot?: () => unknown | Promise<unknown>;
}

export interface BrowserTraceController {
  startRecording(options: Record<string, unknown>): Promise<void>;
  stopRecording(path?: string): Promise<string>;
}

export interface BrowserCaptureCoordinatorOptions {
  readonly maxCaptureBytes?: number;
  readonly emit?: (event: BrowserScreencastFrameEvent) => void;
  readonly contentTracing?: BrowserTraceController;
  /** The host must explicitly identify an exclusive tracing owner. */
  readonly traceOwnership?: boolean | (() => boolean);
}

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserScreenshotResult {
  readonly supported: true;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly data: string;
}

export interface BrowserCapabilityResult {
  readonly supported: false;
  readonly code: "not_supported";
  readonly message: string;
}

export interface BrowserScreencastFrameEvent {
  readonly type: "browser.screencast.frame";
  readonly surfaceId?: string;
  readonly subscriptionId: string;
  readonly width: number;
  readonly height: number;
  readonly data: string;
}

export class BrowserCaptureError extends Error {
  readonly code: BrowserErrorCode;
  readonly method?: string;
  readonly surfaceId?: string;

  constructor(code: BrowserErrorCode, message: string, method?: string, surfaceId?: string) {
    super(message);
    this.name = "BrowserCaptureError";
    this.code = code;
    if (method !== undefined) this.method = method;
    if (surfaceId !== undefined) this.surfaceId = surfaceId;
  }
}

interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type SurfaceKey = object | string;

interface ScreenshotFlight {
  readonly params: Record<string, unknown>;
  readonly operation: Promise<BrowserScreenshotResult>;
}

interface ScreencastSubscription {
  readonly id: string;
  readonly surface: BrowserCaptureSurface | BrowserCaptureContents;
  readonly contents: BrowserCaptureContents;
  readonly maxFrames: number;
  readonly maxFrameBytes: number;
  frames: number;
  stopped: boolean;
}

let nextSubscriptionId = 1;
let traceOwner: symbol | undefined;

const defaultTracing: BrowserTraceController = {
  startRecording: (options) => contentTracing.startRecording(options as never),
  stopRecording: (path) => contentTracing.stopRecording(path),
};

function unsupported(message: string): BrowserCapabilityResult {
  return { supported: false, code: "not_supported", message };
}

function record(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BrowserCaptureError("invalid_params", "params must be an object", method);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, name: string, method: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BrowserCaptureError("invalid_params", `${name} must be finite`, method);
  return value;
}

function positiveInteger(value: unknown, name: string, method: string, maximum: number): number {
  const number = finiteNumber(value, name, method);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new BrowserCaptureError("invalid_params", `${name} must be an integer between 1 and ${maximum}`, method);
  return number;
}

function surfaceContents(surface: BrowserCaptureSurface | BrowserCaptureContents, method: string): BrowserCaptureContents {
  if (typeof surface === "object" && surface !== null && "capturePage" in surface && typeof surface.capturePage === "function") return surface as BrowserCaptureContents;
  const contents = (surface as BrowserCaptureSurface | undefined)?.webContents;
  if (!contents || typeof contents.capturePage !== "function") throw new BrowserCaptureError("not_found", "Browser surface has no live webContents", method, (surface as BrowserCaptureSurface | undefined)?.surfaceId);
  return contents;
}

function surfaceId(surface: BrowserCaptureSurface | BrowserCaptureContents): string | undefined {
  return "surfaceId" in surface && typeof surface.surfaceId === "string" ? surface.surfaceId : undefined;
}

function surfaceKey(surface: BrowserCaptureSurface | BrowserCaptureContents): SurfaceKey {
  const id = surfaceId(surface);
  return id === undefined ? surface : `surface:${id}`;
}

function sameScreenshotOptions(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]));
}

function snapshotRequested(params: Record<string, unknown>, method: string): boolean {
  if (!("snapshotAfter" in params)) return false;
  if (params.snapshotAfter !== true && params.snapshotAfter !== false) throw new BrowserCaptureError("invalid_params", "snapshotAfter must be boolean", method);
  return params.snapshotAfter === true;
}

async function postActionSnapshot(surface: BrowserCaptureSurface | BrowserCaptureContents, requested: boolean, method: string): Promise<Record<string, unknown>> {
  if (!requested) return {};
  if (typeof surface === "object" && surface !== null && "snapshot" in surface && typeof surface.snapshot === "function") return { postActionSnapshot: await surface.snapshot() as BrowserJsonValue };
  if (typeof surface === "object" && surface !== null && "getSnapshot" in surface && typeof surface.getSnapshot === "function") return { postActionSnapshot: await surface.getSnapshot() as BrowserJsonValue };
  if (typeof surface === "object" && surface !== null && "state" in surface) return { postActionSnapshot: (surface as BrowserCaptureSurface).state as BrowserJsonValue };
  throw new BrowserCaptureError("not_supported", "Surface snapshots are not available", method, surfaceId(surface));
}

function clampCrop(value: unknown, viewport: BrowserViewport, method: string): CropRect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BrowserCaptureError("invalid_params", "crop must be an object", method);
  const input = value as Record<string, unknown>;
  const x = finiteNumber(input.x, "crop.x", method);
  const y = finiteNumber(input.y, "crop.y", method);
  const width = finiteNumber(input.width, "crop.width", method);
  const height = finiteNumber(input.height, "crop.height", method);
  if (width <= 0 || height <= 0) throw new BrowserCaptureError("invalid_params", "crop dimensions must be positive", method);
  const left = Math.max(0, Math.min(viewport.width, Math.floor(x)));
  const top = Math.max(0, Math.min(viewport.height, Math.floor(y)));
  const right = Math.min(viewport.width, Math.ceil(x + width));
  const bottom = Math.min(viewport.height, Math.ceil(y + height));
  if (right <= left || bottom <= top) throw new BrowserCaptureError("invalid_params", "crop does not intersect the viewport", method);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function boundedString(value: unknown, name: string, maximum: number, method: string): string {
  if (typeof value !== "string" || value.length > maximum) throw new BrowserCaptureError("invalid_params", `${name} must be a string of at most ${maximum} characters`, method);
  return value;
}

function boundedCategories(value: unknown, name: string, method: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TRACE_CATEGORIES) throw new BrowserCaptureError("invalid_params", `${name} must contain at most ${MAX_TRACE_CATEGORIES} categories`, method);
  return value.map((entry) => boundedString(entry, `${name} entry`, MAX_TRACE_CATEGORY_LENGTH, method));
}

/** Native capture, viewport, screencast, and exclusive tracing coordinator. */
export class BrowserCaptureCoordinator {
  private readonly maxCaptureBytes: number;
  private readonly emitFrame: ((event: BrowserScreencastFrameEvent) => void) | undefined;
  private readonly tracing: BrowserTraceController;
  private readonly traceOwnership: boolean | (() => boolean);
  private readonly viewports = new Map<SurfaceKey, BrowserViewport>();
  private readonly zooms = new Map<SurfaceKey, number>();
  private readonly subscriptions = new Map<string, ScreencastSubscription>();
  private readonly captureFlights = new Map<SurfaceKey, ScreenshotFlight>();
  private traceActive = false;
  private disposed = false;

  constructor(options: BrowserCaptureCoordinatorOptions = {}) {
    const configuredMaxBytes = options.maxCaptureBytes;
    this.maxCaptureBytes = typeof configuredMaxBytes === "number" && Number.isFinite(configuredMaxBytes) ? Math.max(1, Math.min(MAX_CAPTURE_BYTES, Math.floor(configuredMaxBytes))) : MAX_CAPTURE_BYTES;
    this.emitFrame = options.emit;
    this.tracing = options.contentTracing ?? defaultTracing;
    this.traceOwnership = options.traceOwnership ?? false;
  }

  private viewport(surface: BrowserCaptureSurface | BrowserCaptureContents): BrowserViewport {
    return this.viewports.get(surfaceKey(surface)) ?? DEFAULT_VIEWPORT;
  }

  private ensureLive(method: string, surface: BrowserCaptureSurface | BrowserCaptureContents): BrowserCaptureContents {
    if (this.disposed) throw new BrowserCaptureError("invalid_state", "Capture coordinator is disposed", method, surfaceId(surface));
    return surfaceContents(surface, method);
  }

  private async screenshot(params: Record<string, unknown>, surface: BrowserCaptureSurface | BrowserCaptureContents, method: string): Promise<BrowserScreenshotResult> {
    const contents = this.ensureLive(method, surface);
    const viewport = this.viewport(surface);
    const crop = params.crop === undefined ? (params.bounds === undefined ? { x: 0, y: 0, width: viewport.width, height: viewport.height } : clampCrop(params.bounds, viewport, method)) : clampCrop(params.crop, viewport, method);
    if (params.format !== undefined && params.format !== "png") throw new BrowserCaptureError("not_supported", "Only PNG screenshots are supported", method, surfaceId(surface));
    const maxBytes = params.maxBytes === undefined ? this.maxCaptureBytes : positiveInteger(params.maxBytes, "maxBytes", method, this.maxCaptureBytes);
    const key = surfaceKey(surface);
    const flight = this.captureFlights.get(key);
    if (flight && sameScreenshotOptions(flight.params, params)) return flight.operation;
    const operation = (async (): Promise<BrowserScreenshotResult> => {
      try {
        const image = await contents.capturePage(crop);
        const data = image.toPNG();
        const encoded = Buffer.from(data).toString("base64");
        if (data.byteLength > maxBytes || data.byteLength > this.maxCaptureBytes || Buffer.byteLength(encoded, "ascii") > maxBytes) throw new BrowserCaptureError("internal", "Screenshot exceeds the configured byte limit", method, surfaceId(surface));
        const size = image.getSize?.();
        if (size !== undefined && (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width > MAX_VIEWPORT || size.height > MAX_VIEWPORT)) throw new BrowserCaptureError("internal", "Screenshot dimensions exceed the configured limit", method, surfaceId(surface));
        const width = size?.width ?? crop.width;
        const height = size?.height ?? crop.height;
        return { supported: true, mimeType: "image/png", width, height, data: encoded };
      } catch (error) {
        if (error instanceof BrowserCaptureError) throw error;
        throw new BrowserCaptureError("internal", error instanceof Error ? error.message.slice(0, 512) : "Screenshot capture failed", method, surfaceId(surface));
      }
    })();
    this.captureFlights.set(key, { params, operation });
    try { return await operation; } finally {
      if (this.captureFlights.get(key)?.operation === operation) this.captureFlights.delete(key);
    }
  }

  private setViewport(params: Record<string, unknown>, surface: BrowserCaptureSurface | BrowserCaptureContents, method: string): Record<string, unknown> | BrowserCapabilityResult {
    const contents = this.ensureLive(method, surface);
    if (params.reset === true) {
      if (typeof contents.disableDeviceEmulation !== "function") return unsupported("Viewport emulation is unavailable");
      this.viewports.delete(surfaceKey(surface));
      contents.disableDeviceEmulation();
      return { supported: true, viewport: DEFAULT_VIEWPORT };
    }
    if (params.reset !== undefined && params.reset !== false) throw new BrowserCaptureError("invalid_params", "reset must be boolean", method);
    if (typeof contents.enableDeviceEmulation !== "function") return unsupported("Viewport emulation is unavailable");
    const width = positiveInteger(params.width, "width", method, MAX_VIEWPORT);
    const height = positiveInteger(params.height, "height", method, MAX_VIEWPORT);
    const viewport = { width, height } as const;
    this.viewports.set(surfaceKey(surface), viewport);
    contents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: viewport, viewPosition: { x: 0, y: 0 }, viewSize: viewport, deviceScaleFactor: 1, scale: 1 });
    return { supported: true, viewport };
  }

  private setZoom(params: Record<string, unknown>, surface: BrowserCaptureSurface | BrowserCaptureContents, method: string): Record<string, unknown> | BrowserCapabilityResult {
    const contents = this.ensureLive(method, surface);
    if (typeof contents.setZoomFactor !== "function") return unsupported("Zoom control is unavailable");
    const zoom = finiteNumber(params.zoom ?? params.zoomFactor, "zoom", method);
    if (zoom < 0.25 || zoom > 5) throw new BrowserCaptureError("invalid_params", "zoom must be between 0.25 and 5", method, surfaceId(surface));
    contents.setZoomFactor(zoom);
    this.zooms.set(surfaceKey(surface), zoom);
    return { supported: true, zoom };
  }

  private focus(surface: BrowserCaptureSurface | BrowserCaptureContents, method: string): Record<string, unknown> | BrowserCapabilityResult {
    const contents = this.ensureLive(method, surface);
    if (typeof contents.focus !== "function") return unsupported("WebContents focus is unavailable");
    contents.focus();
    return { supported: true, focused: true };
  }

  private async startScreencast(params: Record<string, unknown>, surface: BrowserCaptureSurface | BrowserCaptureContents, method: string): Promise<Record<string, unknown> | BrowserCapabilityResult> {
    const contents = this.ensureLive(method, surface);
    if (typeof contents.beginFrameSubscription !== "function" || typeof contents.endFrameSubscription !== "function") return unsupported("Screencast frame subscription is unavailable");
    if ([...this.subscriptions.values()].some((entry) => entry.contents === contents && !entry.stopped)) throw new BrowserCaptureError("invalid_state", "A screencast is already active for this surface", method, surfaceId(surface));
    const maxFrames = params.maxFrames === undefined ? MAX_FRAME_COUNT : positiveInteger(params.maxFrames, "maxFrames", method, MAX_FRAME_COUNT);
    const maxFrameBytes = params.maxFrameBytes === undefined ? MAX_FRAME_BYTES : positiveInteger(params.maxFrameBytes, "maxFrameBytes", method, MAX_FRAME_BYTES);
    const subscription: ScreencastSubscription = { id: `screencast:${nextSubscriptionId++}`, surface, contents, maxFrames, maxFrameBytes, frames: 0, stopped: false };
    this.subscriptions.set(subscription.id, subscription);
    try {
      contents.beginFrameSubscription(false, (image, dirtyRect) => {
        if (subscription.stopped || subscription.frames >= subscription.maxFrames) return;
        subscription.frames += 1;
        const png = image.toPNG();
        if (png.byteLength <= subscription.maxFrameBytes) {
          const data = Buffer.from(png).toString("base64");
          if (Buffer.byteLength(data, "ascii") <= subscription.maxFrameBytes) {
            const candidate = dirtyRect && typeof dirtyRect === "object" && "width" in dirtyRect && "height" in dirtyRect && typeof dirtyRect.width === "number" && typeof dirtyRect.height === "number" ? { width: dirtyRect.width, height: dirtyRect.height } : this.viewport(surface);
            const width = Number.isFinite(candidate.width) ? Math.min(MAX_VIEWPORT, Math.max(1, Math.floor(candidate.width))) : this.viewport(surface).width;
            const height = Number.isFinite(candidate.height) ? Math.min(MAX_VIEWPORT, Math.max(1, Math.floor(candidate.height))) : this.viewport(surface).height;
            const frameSurfaceId = surfaceId(surface);
            const event: BrowserScreencastFrameEvent = { type: "browser.screencast.frame", subscriptionId: subscription.id, width, height, data, ...(frameSurfaceId === undefined ? {} : { surfaceId: frameSurfaceId }) };
            this.emitFrame?.(event);
          }
        }
        if (subscription.frames >= subscription.maxFrames) this.stopScreencast(subscription.id);
      });
    } catch (error) {
      this.subscriptions.delete(subscription.id);
      throw new BrowserCaptureError("internal", error instanceof Error ? error.message.slice(0, 512) : "Unable to start screencast", method, surfaceId(surface));
    }
    return { supported: true, subscriptionId: subscription.id, maxFrames, maxFrameBytes };
  }

  private stopScreencast(subscriptionId: string): Record<string, unknown> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return { supported: true, stopped: false, subscriptionId };
    if (!subscription.stopped) {
      subscription.stopped = true;
      try { subscription.contents.endFrameSubscription?.(); } catch { /* disposal is best effort */ }
    }
    this.subscriptions.delete(subscriptionId);
    return { supported: true, stopped: true, subscriptionId, frames: subscription.frames };
  }

  private ownsTrace(params: Record<string, unknown>): boolean {
    if (params.exclusive !== true && params.exclusiveOwnership !== true) return false;
    const ownership = typeof this.traceOwnership === "function" ? this.traceOwnership() : this.traceOwnership;
    return ownership === true;
  }

  private async startTrace(params: Record<string, unknown>, method: string): Promise<Record<string, unknown> | BrowserCapabilityResult> {
    if (!this.ownsTrace(params)) return unsupported("Tracing requires exclusive ownership");
    if (this.traceActive) throw new BrowserCaptureError("invalid_state", "Tracing is already active", method);
    if (traceOwner !== undefined && traceOwner !== this.traceToken) return unsupported("Another owner is recording a trace");
    const included = boundedCategories(params.includedCategories ?? params.included_categories, "includedCategories", method);
    const excluded = boundedCategories(params.excludedCategories ?? params.excluded_categories, "excludedCategories", method);
    try {
      traceOwner = this.traceToken;
      await this.tracing.startRecording({ included_categories: included, excluded_categories: excluded, record_mode: "record-until-full" });
      this.traceActive = true;
      return { supported: true, recording: true };
    } catch (error) {
      if (traceOwner === this.traceToken) traceOwner = undefined;
      throw new BrowserCaptureError("internal", error instanceof Error ? error.message.slice(0, 512) : "Unable to start tracing", method);
    }
  }

  private readonly traceToken = Symbol("browser-trace-owner");

  private async stopTrace(params: Record<string, unknown>, method: string): Promise<Record<string, unknown> | BrowserCapabilityResult> {
    if (!this.traceActive) return { supported: true, recording: false, stopped: false };
    if (!this.ownsTrace(params)) return unsupported("Tracing requires exclusive ownership");
    const path = params.path === undefined ? undefined : boundedString(params.path, "path", MAX_TRACE_PATH_LENGTH, method);
    try {
      const result = await this.tracing.stopRecording(path);
      this.traceActive = false;
      if (traceOwner === this.traceToken) traceOwner = undefined;
      return { supported: true, recording: false, stopped: true, path: typeof result === "string" ? result.slice(0, MAX_TRACE_PATH_LENGTH) : undefined };
    } catch (error) {
      throw new BrowserCaptureError("internal", error instanceof Error ? error.message.slice(0, 512) : "Unable to stop tracing", method);
    }
  }

  async call(method: string, params: unknown, surface: BrowserCaptureSurface | BrowserCaptureContents): Promise<Record<string, unknown> | BrowserScreenshotResult | BrowserCapabilityResult> {
    const input = record(params, method);
    switch (method) {
      case "surface.screenshot":
      case "browser.screenshot":
        return this.screenshot(input, surface, method);
      case "browser.viewport.set": {
        const requested = snapshotRequested(input, method);
        const result = this.setViewport(input, surface, method);
        return { ...result, ...(await postActionSnapshot(surface, requested, method)) };
      }
      case "browser.zoom.set": {
        const requested = snapshotRequested(input, method);
        const result = this.setZoom(input, surface, method);
        return { ...result, ...(await postActionSnapshot(surface, requested, method)) };
      }
      case "browser.focus_webview":
      case "surface.focusWebView": {
        const requested = snapshotRequested(input, method);
        const result = this.focus(surface, method);
        return { ...result, ...(await postActionSnapshot(surface, requested, method)) };
      }
      case "browser.is_webview_focused": {
        const contents = this.ensureLive(method, surface);
        return { supported: true, focused: contents.isFocused?.() === true };
      }
      case "browser.screencast.start":
        return this.startScreencast(input, surface, method);
      case "browser.screencast.stop":
        return this.stopScreencast(typeof input.subscriptionId === "string" ? input.subscriptionId : "");
      case "browser.trace.start":
        return this.startTrace(input, method);
      case "browser.trace.stop":
        return this.stopTrace(input, method);
      default:
        return unsupported(`Capture capability ${method} is not supported`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.subscriptions.keys()) this.stopScreencast(id);
    if (this.traceActive && traceOwner === this.traceToken) {
      void this.tracing.stopRecording().catch(() => undefined);
      traceOwner = undefined;
      this.traceActive = false;
    }
    this.viewports.clear();
    this.zooms.clear();
    this.captureFlights.clear();
  }
}
