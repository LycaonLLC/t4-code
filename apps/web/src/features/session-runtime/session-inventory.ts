import type { DesktopRuntimeSnapshot } from "@t4-code/client";

/** True only when this host has supplied one complete current session inventory. */
export function hostSessionInventoryIsComplete(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
): boolean {
  const metadata = snapshot.projection.sessionIndexMetadata.get(hostId);
  if (metadata === undefined || metadata.truncated) return false;
  let indexed = 0;
  for (const ref of snapshot.projection.sessionIndex.values()) {
    if (String(ref.hostId) === hostId) indexed += 1;
  }
  return indexed === metadata.totalCount;
}

export type SessionWriteLink = "live" | "cached" | "offline";

/** True only when this process received the ref after the latest reconnect boundary. */
export function sessionRefIsCurrent(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
  sessionId: string,
): boolean {
  const key = `${hostId}\u0000${sessionId}`;
  return (
    snapshot.projection.sessionIndex.has(key) &&
    snapshot.projection.sessionRefArrivalOrdinals.has(key)
  );
}

/**
 * Dispatch-time freshness for one session, stricter than the render link:
 * offline when the target is not connected; live ONLY when the target is
 * bound to this host, THIS session has a ref from the current connection,
 * and any warm projection is fresh. A truncated host inventory is safe for
 * a ref it actually returned; retained refs that were not returned after a
 * reconnect stay cached/read-only.
 */
export function sessionWriteLink(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostId: string,
  sessionId: string,
): SessionWriteLink {
  if (snapshot.connections.get(targetId) !== "connected") return "offline";
  const key = `${hostId}\u0000${sessionId}`;
  const warm = snapshot.projection.sessions.get(key);
  const inventoryReady =
    snapshot.targetHosts.get(targetId) === hostId &&
    sessionRefIsCurrent(snapshot, hostId, sessionId);
  return !inventoryReady || (warm !== undefined && warm.freshness !== "fresh")
    ? "cached"
    : "live";
}
