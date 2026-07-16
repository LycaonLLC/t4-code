import { describe, expect, it } from "vite-plus/test";

import {
  bindBrowserConnectionWake,
  NATIVE_APP_RESUME_EVENT,
} from "../src/platform/browser-connection-lifecycle.ts";

class FakeLifecycleTarget {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    const event = { type } as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("browser connection lifecycle", () => {
  it("coalesces visible, online, pageshow, and native resume wakes", () => {
    const windowTarget = new FakeLifecycleTarget();
    const documentTarget = new FakeLifecycleTarget();
    const scheduled: Array<() => void> = [];
    let wakes = 0;
    const dispose = bindBrowserConnectionWake(
      () => {
        wakes += 1;
      },
      {
        windowTarget,
        documentTarget,
        schedule: (callback) => scheduled.push(callback),
      },
    );

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatch("visibilitychange");
    windowTarget.dispatch("online");
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(wakes).toBe(0);

    documentTarget.visibilityState = "visible";
    documentTarget.dispatch("visibilitychange");
    windowTarget.dispatch("pageshow");
    windowTarget.dispatch("online");
    windowTarget.dispatch(NATIVE_APP_RESUME_EVENT);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(wakes).toBe(1);

    documentTarget.visibilityState = "hidden";
    windowTarget.dispatch(NATIVE_APP_RESUME_EVENT);
    scheduled.shift()?.();
    expect(wakes).toBe(2);

    dispose();
    documentTarget.visibilityState = "visible";
    windowTarget.dispatch("online");
    expect(scheduled).toHaveLength(0);
    expect(wakes).toBe(2);
  });
});
