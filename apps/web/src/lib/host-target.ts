import type { DesktopRuntimeSnapshot } from "@t4-code/client";

/**
 * Resolve the current target for a host. A connected duplicate wins over an
 * earlier offline binding, while targets absent from the authoritative
 * connection inventory are ignored as removed.
 */
export function resolveCurrentHostTargetId(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
): string | null {
  let offlineTargetId: string | null = null;
  for (const [targetId, boundHostId] of snapshot.targetHosts) {
    if (boundHostId !== hostId) continue;
    const state = snapshot.connections.get(targetId);
    if (state === undefined) continue;
    if (state === "connected") return targetId;
    offlineTargetId ??= targetId;
  }
  return offlineTargetId;
}
