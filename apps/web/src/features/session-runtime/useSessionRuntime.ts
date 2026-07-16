// React binding for session runtimes. Keeps a small LRU of paused runtimes
// so A→B→A switching restores a session's projection from memory instantly
// (DESIGN_PLAN continuity: LRU of eight sessions). Desktop mode builds live
// controller-backed runtimes; browser mode builds deterministic fixtures.
import type { DesktopRuntimeController } from "@t4-code/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { desktopRuntime } from "../../platform/desktop-runtime.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import {
  createFixtureSessionRuntime,
  type SessionLink,
  type SessionRuntime,
  type SessionRuntimeSnapshot,
} from "./controller.ts";
import type { TranscriptVariant } from "./fixtures.ts";
import { createLiveSessionRuntime } from "./live-runtime.ts";

const RUNTIME_LRU_LIMIT = 8;
const runtimeCache = new Map<string, SessionRuntime>();

/** QA/screenshot switch: pin a scripted transcript variant. */
export function parseTranscriptVariant(search: string): TranscriptVariant {
  const value = new URLSearchParams(search).get("transcript");
  return value === "stress" || value === "gap" || value === "compaction"
    ? value
    : "default";
}

function rememberRuntime(
  cache: Map<string, SessionRuntime>,
  cacheKey: string,
  runtime: SessionRuntime,
): void {
  cache.set(cacheKey, runtime);
  if (cache.size > RUNTIME_LRU_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.get(oldestKey)?.dispose();
      cache.delete(oldestKey);
    }
  }
}

function refreshRecency(
  cache: Map<string, SessionRuntime>,
  cacheKey: string,
): SessionRuntime | undefined {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh recency: Map iteration order is insertion order.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
  }
  return cached;
}

/**
 * Obtain (or reuse) the live runtime for a session view id. Selecting a
 * session reuses the cached runtime; attachment is owned by that runtime so
 * it follows controller connection state.
 */
export function obtainLiveRuntime(
  controller: DesktopRuntimeController,
  sessionKey: string,
  cache: Map<string, SessionRuntime> = runtimeCache,
): SessionRuntime {
  // Live runtimes key on the session alone: link changes must reuse the
  // same runtime (and its transcript) instead of recreating it.
  const cacheKey = `live\u0000${sessionKey}`;
  const cached = refreshRecency(cache, cacheKey);
  if (cached !== undefined) return cached;
  const address = resolveLiveSession(controller.getSnapshot(), sessionKey);
  const separator = sessionKey.indexOf("/");
  const hostId =
    address?.hostId ?? decodeURIComponent(separator > 0 ? sessionKey.slice(0, separator) : sessionKey);
  const sessionId =
    address?.sessionId ?? decodeURIComponent(separator > 0 ? sessionKey.slice(separator + 1) : "");
  const runtime = createLiveSessionRuntime({
    controller,
    targetId: address?.targetId ?? "local",
    hostId,
    sessionId,
  });
  rememberRuntime(cache, cacheKey, runtime);
  return runtime;
}

function obtainRuntime(sessionKey: string, link: SessionLink): SessionRuntime {
  const controller = desktopRuntime();
  if (controller !== null) return obtainLiveRuntime(controller, sessionKey);
  const variant =
    typeof window !== "undefined" ? parseTranscriptVariant(window.location.search) : "default";
  const cacheKey = `${sessionKey}\u0000${variant}\u0000${link}`;
  const cached = refreshRecency(runtimeCache, cacheKey);
  if (cached !== undefined) return cached;
  const runtime = createFixtureSessionRuntime({ sessionKey, variant, link });
  rememberRuntime(runtimeCache, cacheKey, runtime);
  return runtime;
}

export interface UseSessionRuntimeResult {
  readonly runtime: SessionRuntime;
  readonly snapshot: SessionRuntimeSnapshot;
}

export function useSessionRuntime(sessionKey: string, link: SessionLink): UseSessionRuntimeResult {
  const runtime = useMemo(() => obtainRuntime(sessionKey, link), [sessionKey, link]);

  useEffect(() => {
    runtime.resume();
    return () => runtime.pause();
  }, [runtime]);

  const snapshot = useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.getSnapshot(),
  );

  return { runtime, snapshot };
}
