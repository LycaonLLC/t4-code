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
