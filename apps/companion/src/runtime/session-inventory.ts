import type { ProjectionStore } from "@t4-code/client";
import {
  PROTOCOL_VERSION,
  decodeSessionListResult,
  decodeSessions,
  type Cursor,
} from "@t4-code/protocol";

/**
 * Materialize the authoritative session.list response in the same shared
 * projection used by live session.delta events.
 */
export function applySessionListInventory(
  projection: ProjectionStore,
  currentHostId: string,
  input: unknown,
): Cursor {
  const list = decodeSessionListResult(input);
  const frame = decodeSessions({
    v: PROTOCOL_VERSION,
    type: "sessions",
    hostId: currentHostId,
    cursor: list.cursor,
    sessions: list.sessions,
    totalCount: list.totalCount,
    truncated: list.truncated,
  });
  projection.applyPublicFrame(frame);
  return list.cursor;
}
