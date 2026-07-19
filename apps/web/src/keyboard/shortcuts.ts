// Global shortcut resolution. Pure so keyboard behavior is testable without
// a DOM. Digit handling via `event.code` follows T3 Code
// apps/web/src/keybindings.ts (MIT, T3 Tools Inc., reference only): `key`
// reports layout characters, `code` reports the physical digit row.

export interface ShortcutEventLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export type ShortcutAction =
  | { readonly kind: "palette" }
  | { readonly kind: "toggle-rail" }
  | { readonly kind: "toggle-terminal" }
  | { readonly kind: "settings" }
  | { readonly kind: "session-index"; readonly index: number };

/**
 * Map a keydown to a shell action. Cmd/Ctrl+K → palette, Cmd/Ctrl+B → rail,
 * Cmd/Ctrl+J → terminal, Cmd/Ctrl+Comma → settings,
 * Cmd/Ctrl+1..9 → visible session by position.
 * Anything else is null.
 */
export function resolveShortcut(event: ShortcutEventLike): ShortcutAction | null {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey || event.shiftKey) return null;

  const key = event.key.toLowerCase();
  if (key === "k") return { kind: "palette" };
  if (key === "b") return { kind: "toggle-rail" };
  if (key === "j") return { kind: "toggle-terminal" };
  if (key === ",") return { kind: "settings" };

  const digit = event.code?.match(/^Digit([1-9])$/)?.[1] ?? key.match(/^([1-9])$/)?.[1];
  if (digit !== undefined) return { kind: "session-index", index: Number(digit) - 1 };
  return null;
}

/** True when the event target owns typing (inputs, textareas, editors). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
