import type {
  DesktopUpdateOpenEvent,
  DesktopUpdateRendererReadyResult,
} from "@t4-code/protocol/desktop-ipc";

import { rendererPlatform } from "../../state/store-instance.ts";

type Listener = () => void;

let request = 0;
let consumedRequest = 0;
const listeners = new Set<Listener>();

export function requestUpdateSettingsFocus(): void {
  request += 1;
  for (const listener of listeners) listener();
}

export function getUpdateSettingsRequest(): number {
  return request;
}

/** A native-menu request should affect one settings mount, not every later visit. */
export function consumeUpdateSettingsRequest(value: number): boolean {
  if (value <= consumedRequest) return false;
  consumedRequest = value;
  return true;
}

export function subscribeUpdateSettingsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe once from the persistent titlebar; the shell never owns routing. */
export function subscribeNativeUpdateSettingsOpen(listener: () => void): () => void {
  const shell = rendererPlatform.shell as typeof rendererPlatform.shell & {
    readonly updateRendererReady?: () => Promise<DesktopUpdateRendererReadyResult>;
    readonly onOpenUpdateSettings?: (
      listener: (event: DesktopUpdateOpenEvent) => void,
    ) => () => void;
  };
  const openSettings = (): void => {
    requestUpdateSettingsFocus();
    listener();
  };
  const unsubscribe = shell?.onOpenUpdateSettings?.(openSettings) ?? (() => undefined);
  void shell?.updateRendererReady?.().then(
    (result) => {
      if (result.openSettings) openSettings();
    },
    () => undefined,
  );
  return unsubscribe;
}
