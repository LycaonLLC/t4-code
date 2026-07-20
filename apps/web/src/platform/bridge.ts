// Renderer platform seam. The Electron preload injects `window.ompShell`,
// which is a `DesktopShellPort` — a typed command/event port to the desktop
// backend and nothing more. It has no UI persistence: workspace view state
// is always renderer-local (localStorage), in both modes. Components never
// look past this boundary for platform facts.
import type { DesktopShellPort } from "@t4-code/client";

import { createBrowserShellPort } from "./browser-shell-port.ts";
import { createLocalStoragePersistence, type WorkspacePersistence } from "../state/persistence.ts";
import { WORKSPACE_STORAGE_KEY } from "../state/workspace-store.ts";

export type ShellPlatform = "linux" | "darwin";

export interface RendererPlatform {
  /** "desktop" when a live desktop-compatible shell port is available. */
  readonly mode: "desktop" | "browser";
  /** Native window chrome exists only when Electron injected the shell port. */
  readonly windowChrome: ShellPlatform | null;
  readonly platform: ShellPlatform;
  /** Workspace view-state persistence; always renderer-local. */
  readonly persistence: WorkspacePersistence;
  /** The desktop command/event port; null in the browser. */
  readonly shell: DesktopShellPort | null;
}

declare global {
  interface Window {
    ompShell?: DesktopShellPort;
  }
}

function injectedShell(): DesktopShellPort | null {
  if (typeof window === "undefined") return null;
  const shell = window.ompShell;
  return shell !== undefined && shell.kind === "desktop" ? shell : null;
}

export function resolveRendererPlatform(platformOverride?: ShellPlatform): RendererPlatform {
  const shell = injectedShell();
  const platform =
    shell?.platform ??
    platformOverride ??
    (typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "darwin" : "linux");

  // Browser mode: try to create a browser-direct shell port that connects
  // to the OMP appserver over WebSocket. If no backend config is detected,
  // fall through to the original browser mode (fixture/demo data).
  let resolvedShell: DesktopShellPort | null = shell;
  if (resolvedShell === null) {
    resolvedShell = createBrowserShellPort();
  }

  return {
    mode: resolvedShell === null ? "browser" : "desktop",
    platform,
    windowChrome: shell === null ? null : platform,
    persistence: createLocalStoragePersistence(WORKSPACE_STORAGE_KEY),
    shell: resolvedShell,
  };
}
