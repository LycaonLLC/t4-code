import type { InputEvent, KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from "electron";
import type { BrowserErrorCode, BrowserJsonValue } from "@t4-code/protocol/browser-ipc";
type BrowserMouseInputEvent = MouseInputEvent;
type BrowserMouseWheelInputEvent = MouseWheelInputEvent;
type BrowserKeyboardInputEvent = KeyboardInputEvent;
type BrowserInputModifier = NonNullable<InputEvent["modifiers"]>[number];

export type BrowserInputEvent = BrowserMouseInputEvent | BrowserMouseWheelInputEvent | BrowserKeyboardInputEvent;

const MAX_COORDINATE = 1_000_000;
const MAX_KEY_LENGTH = 64;
const MAX_MODIFIERS = 8;

export interface BrowserInputContents {
  focus?(): void;
  sendInputEvent(event: BrowserInputEvent): void | Promise<void>;
}

export interface BrowserInputSurface {
  readonly webContents?: BrowserInputContents | null;
  readonly surfaceId?: string;
  readonly state?: unknown;
  readonly snapshot?: () => unknown | Promise<unknown>;
  readonly getSnapshot?: () => unknown | Promise<unknown>;
}

export interface BrowserInputCapabilityResult {
  readonly supported: false;
  readonly code: "not_supported";
  readonly message: string;
}

export class BrowserInputError extends Error {
  readonly code: BrowserErrorCode;
  readonly method?: string;
  readonly surfaceId?: string;

  constructor(code: BrowserErrorCode, message: string, method?: string, surfaceId?: string) {
    super(message);
    this.name = "BrowserInputError";
    this.code = code;
    if (method !== undefined) this.method = method;
    if (surfaceId !== undefined) this.surfaceId = surfaceId;
  }
}

const KNOWN_KEYS: Record<string, true> = {
  Enter: true, Escape: true, Tab: true, Backspace: true, Delete: true, Insert: true,
  ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true,
  Home: true, End: true, PageUp: true, PageDown: true,
  Shift: true, Control: true, Alt: true, Meta: true, Super: true,
  CapsLock: true, NumLock: true, ScrollLock: true, PrintScreen: true, Pause: true,
  ContextMenu: true, Clear: true, Help: true, Space: true,
  Add: true, Subtract: true, Multiply: true, Divide: true, Decimal: true,
};
for (let index = 1; index <= 24; index += 1) KNOWN_KEYS[`F${index}`] = true;

const KNOWN_MODIFIERS: Record<BrowserInputModifier, true> = {
  shift: true,
  control: true,
  ctrl: true,
  alt: true,
  meta: true,
  command: true,
  cmd: true,
  iskeypad: true,
  isautorepeat: true,
  leftbuttondown: true,
  middlebuttondown: true,
  rightbuttondown: true,
  capslock: true,
  numlock: true,
  left: true,
  right: true,
};

function unsupported(message: string): BrowserInputCapabilityResult {
  return { supported: false, code: "not_supported", message };
}

function inputRecord(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BrowserInputError("invalid_params", "params must be an object", method);
  return value as Record<string, unknown>;
}

function contentsFor(surface: BrowserInputSurface | BrowserInputContents, method: string): BrowserInputContents {
  if (typeof surface === "object" && surface !== null && "sendInputEvent" in surface && typeof surface.sendInputEvent === "function") return surface as BrowserInputContents;
  const contents = (surface as BrowserInputSurface).webContents;
  if (!contents || typeof contents.sendInputEvent !== "function") throw new BrowserInputError("not_found", "Browser surface has no live webContents", method, (surface as BrowserInputSurface).surfaceId);
  return contents;
}

function numeric(value: unknown, name: string, method: string, minimum = -MAX_COORDINATE, maximum = MAX_COORDINATE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new BrowserInputError("invalid_params", `${name} must be finite and between ${minimum} and ${maximum}`, method);
  return value;
}

function integer(value: unknown, name: string, method: string, minimum: number, maximum: number): number {
  const number = numeric(value, name, method, minimum, maximum);
  if (!Number.isSafeInteger(number)) throw new BrowserInputError("invalid_params", `${name} must be an integer`, method);
  return number;
}

function modifiers(value: unknown, method: string): BrowserInputModifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MODIFIERS) throw new BrowserInputError("invalid_params", `modifiers must contain at most ${MAX_MODIFIERS} values`, method);
  const result: BrowserInputModifier[] = [];
  for (const modifier of value) {
    if (typeof modifier !== "string" || KNOWN_MODIFIERS[modifier as BrowserInputModifier] !== true) throw new BrowserInputError("invalid_params", "Unknown keyboard modifier", method);
    const typedModifier = modifier as BrowserInputModifier;
    if (!result.includes(typedModifier)) result.push(typedModifier);
  }
  return result;
}

function keyCode(value: unknown, method: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_LENGTH) throw new BrowserInputError("invalid_params", `keyCode must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`, method);
  if (value.length === 1 || KNOWN_KEYS[value] === true) return value;
  throw new BrowserInputError("invalid_params", `Unknown key ${value}`, method);
}

function snapshotRequested(params: Record<string, unknown>, method: string): boolean {
  if (!("snapshotAfter" in params)) return false;
  if (params.snapshotAfter !== true && params.snapshotAfter !== false) throw new BrowserInputError("invalid_params", "snapshotAfter must be boolean", method);
  return params.snapshotAfter === true;
}

async function snapshotAfter(surface: BrowserInputSurface | BrowserInputContents, requested: boolean, method: string): Promise<Record<string, unknown>> {
  if (!requested) return {};
  if (typeof surface === "object" && surface !== null && "snapshot" in surface && typeof surface.snapshot === "function") return { postActionSnapshot: await surface.snapshot() as BrowserJsonValue };
  if (typeof surface === "object" && surface !== null && "getSnapshot" in surface && typeof surface.getSnapshot === "function") return { postActionSnapshot: await surface.getSnapshot() as BrowserJsonValue };
  if (typeof surface === "object" && surface !== null && "state" in surface) return { postActionSnapshot: (surface as BrowserInputSurface).state as BrowserJsonValue };
  throw new BrowserInputError("not_supported", "Surface snapshots are not available", method, (surface as BrowserInputSurface).surfaceId);
}

function mouseEvent(params: Record<string, unknown>, method: string): BrowserMouseInputEvent | BrowserMouseWheelInputEvent {
  const type = params.type;
  if (type !== "mouseDown" && type !== "mouseUp" && type !== "mouseMove" && type !== "mouseWheel") throw new BrowserInputError("invalid_params", "Unknown mouse event type", method);
  const x = numeric(params.x, "x", method);
  const y = numeric(params.y, "y", method);
  let event: BrowserMouseInputEvent | BrowserMouseWheelInputEvent = type === "mouseWheel"
    ? { type, x, y, deltaX: numeric(params.deltaX ?? 0, "deltaX", method), deltaY: numeric(params.deltaY ?? 0, "deltaY", method) }
    : { type, x, y };
  if (type !== "mouseWheel" && params.button !== undefined) {
    if (params.button !== "left" && params.button !== "middle" && params.button !== "right") throw new BrowserInputError("invalid_params", "Unknown mouse button", method);
    event.button = params.button;
  }
  if (params.clickCount !== undefined) event.clickCount = integer(params.clickCount, "clickCount", method, 1, 16);
  if (params.modifiers !== undefined) event.modifiers = modifiers(params.modifiers, method);
  return event;
}

function keyboardEvent(params: Record<string, unknown>, method: string): BrowserKeyboardInputEvent {
  const type = params.type;
  if (type !== "keyDown" && type !== "keyUp" && type !== "char") throw new BrowserInputError("invalid_params", "Unknown keyboard event type", method);
  const event: BrowserKeyboardInputEvent = { type, keyCode: keyCode(params.keyCode ?? params.key, method) };
  if (params.modifiers !== undefined) event.modifiers = modifiers(params.modifiers, method);
  return event;
}

/** Validates and forwards raw native WebContents input events. */
export class BrowserInputCoordinator {
  private disposed = false;

  private ensureLive(method: string, surface: BrowserInputSurface | BrowserInputContents): BrowserInputContents {
    if (this.disposed) throw new BrowserInputError("invalid_state", "Input coordinator is disposed", method, (surface as BrowserInputSurface).surfaceId);
    return contentsFor(surface, method);
  }

  async call(method: string, params: unknown, surface: BrowserInputSurface | BrowserInputContents): Promise<Record<string, unknown> | BrowserInputCapabilityResult> {
    if (method === "browser.input_touch") return unsupported("Touch input is not supported by Electron WebContents.sendInputEvent");
    const input = inputRecord(params, method);
    let event: BrowserInputEvent;
    switch (method) {
      case "browser.input_mouse":
        event = mouseEvent(input, method);
        break;
      case "browser.input_keyboard":
        event = keyboardEvent(input, method);
        break;
      default:
        return unsupported(`Input capability ${method} is not supported`);
    }
    const requested = snapshotRequested(input, method);
    const contents = this.ensureLive(method, surface);
    try {
      await contents.sendInputEvent(event);
    } catch (error) {
      throw new BrowserInputError("internal", error instanceof Error ? error.message.slice(0, 512) : "Unable to dispatch input event", method, (surface as BrowserInputSurface).surfaceId);
    }
    return { supported: true, dispatched: true, eventType: event.type, ...(await snapshotAfter(surface, requested, method)) };
  }

  dispose(): void {
    this.disposed = true;
  }
}
