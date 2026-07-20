import { describe, expect, it } from "vite-plus/test";

import {
  resolveShortcut,
  resolveShortcutInvocation,
  type ShortcutEventLike,
} from "../src/keyboard/shortcuts.ts";

function event(partial: Partial<ShortcutEventLike>): ShortcutEventLike {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("resolveShortcut", () => {
  it("maps Cmd/Ctrl+K to the palette on both platforms", () => {
    expect(resolveShortcut(event({ key: "k", ctrlKey: true }))).toEqual({ kind: "palette" });
    expect(resolveShortcut(event({ key: "K", metaKey: true }))).toEqual({ kind: "palette" });
  });

  it("maps Cmd/Ctrl+B to the rail toggle", () => {
    expect(resolveShortcut(event({ key: "b", ctrlKey: true }))).toEqual({ kind: "toggle-rail" });
  });

  it("maps Cmd/Ctrl+J to the active session terminal", () => {
    expect(resolveShortcut(event({ key: "j", ctrlKey: true }))).toEqual({
      kind: "toggle-terminal",
    });
    expect(resolveShortcut(event({ key: "J", metaKey: true }))).toEqual({
      kind: "toggle-terminal",
    });
  });

  it("maps Cmd/Ctrl+Shift+F to focus mode", () => {
    expect(resolveShortcut(event({ key: "f", ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "toggle-focus",
    });
    expect(resolveShortcut(event({ key: "F", metaKey: true, shiftKey: true }))).toEqual({
      kind: "toggle-focus",
    });
  });

  it("maps Cmd/Ctrl+1..9 to zero-based session positions", () => {
    expect(resolveShortcut(event({ key: "1", code: "Digit1", ctrlKey: true }))).toEqual({
      kind: "session-index",
      index: 0,
    });
    expect(resolveShortcut(event({ key: "9", code: "Digit9", metaKey: true }))).toEqual({
      kind: "session-index",
      index: 8,
    });
  });

  it("resolves digits from the physical key on non-QWERTY layouts", () => {
    expect(resolveShortcut(event({ key: "&", code: "Digit1", ctrlKey: true }))).toEqual({
      kind: "session-index",
      index: 0,
    });
  });

  it("ignores unmodified keys, extra modifiers, and other keys", () => {
    expect(resolveShortcut(event({ key: "k" }))).toBeNull();
    expect(resolveShortcut(event({ key: "k", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveShortcut(event({ key: "k", ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveShortcut(event({ key: "0", code: "Digit0", ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(event({ key: "x", ctrlKey: true }))).toBeNull();
  });
});

describe("resolveShortcutInvocation", () => {
  it("maps shell keys to typed registry actions", () => {
    expect(resolveShortcutInvocation(event({ key: "k", metaKey: true }), () => [])).toEqual({
      id: "palette.toggle",
      args: undefined,
    });
    expect(resolveShortcutInvocation(event({ key: ",", ctrlKey: true }), () => [])).toEqual({
      id: "settings.open",
      args: undefined,
    });
  });

  it("resolves a numeric key against the current visible session order", () => {
    expect(
      resolveShortcutInvocation(event({ key: "2", code: "Digit2", metaKey: true }), () => [
        "a",
        "b",
      ]),
    ).toEqual({ id: "session.open", args: { sessionId: "b" } });
    expect(
      resolveShortcutInvocation(event({ key: "3", code: "Digit3", metaKey: true }), () => [
        "a",
        "b",
      ]),
    ).toBeNull();
  });
});
