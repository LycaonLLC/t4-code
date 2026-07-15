import type { Unsubscribe } from "@t4-code/client";

export const NATIVE_APP_RESUME_EVENT = "t4:native-resume";

export interface LifecycleEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface LifecycleDocumentTarget extends LifecycleEventTarget {
  readonly visibilityState?: DocumentVisibilityState;
}

export interface BrowserConnectionLifecycleOptions {
  readonly windowTarget?: LifecycleEventTarget | null;
  readonly documentTarget?: LifecycleDocumentTarget | null;
  readonly schedule?: (callback: () => void) => void;
}

/**
 * Coalesce the browser and native signals that mean a suspended connection
 * should be checked now. Hidden documents do not consume reconnect budget;
 * Android's explicit resume signal is trusted even on WebViews that do not
 * update document.visibilityState reliably.
 */
export function bindBrowserConnectionWake(
  wake: () => void,
  options: BrowserConnectionLifecycleOptions = {},
): Unsubscribe {
  const windowTarget =
    options.windowTarget === undefined
      ? typeof window === "undefined"
        ? null
        : window
      : options.windowTarget;
  const documentTarget =
    options.documentTarget === undefined
      ? typeof document === "undefined"
        ? null
        : document
      : options.documentTarget;
  const schedule =
    options.schedule ??
    (typeof queueMicrotask === "function"
      ? queueMicrotask
      : (callback: () => void) => {
          void Promise.resolve().then(callback);
        });
  let queued = false;
  let disposed = false;
  let nativeResumeQueued = false;

  const visible = (): boolean => documentTarget?.visibilityState !== "hidden";
  const requestWake = (nativeResume: boolean): void => {
    if (disposed) return;
    nativeResumeQueued ||= nativeResume;
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      const allowHidden = nativeResumeQueued;
      nativeResumeQueued = false;
      if (!disposed && (allowHidden || visible())) wake();
    });
  };
  const onVisibility = (): void => {
    if (visible()) requestWake(false);
  };
  const onPageShow = (): void => requestWake(false);
  const onOnline = (): void => requestWake(false);
  const onNativeResume = (): void => requestWake(true);
  const documentEvents =
    documentTarget !== null &&
    typeof documentTarget.addEventListener === "function" &&
    typeof documentTarget.removeEventListener === "function";
  const windowEvents =
    windowTarget !== null &&
    typeof windowTarget.addEventListener === "function" &&
    typeof windowTarget.removeEventListener === "function";

  if (documentEvents) documentTarget.addEventListener("visibilitychange", onVisibility);
  if (windowEvents) {
    windowTarget.addEventListener("pageshow", onPageShow);
    windowTarget.addEventListener("online", onOnline);
    windowTarget.addEventListener(NATIVE_APP_RESUME_EVENT, onNativeResume);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (documentEvents) documentTarget.removeEventListener("visibilitychange", onVisibility);
    if (windowEvents) {
      windowTarget.removeEventListener("pageshow", onPageShow);
      windowTarget.removeEventListener("online", onOnline);
      windowTarget.removeEventListener(NATIVE_APP_RESUME_EVENT, onNativeResume);
    }
  };
}
