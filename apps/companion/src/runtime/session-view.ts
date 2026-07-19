import type { PendingAttentionItem, SessionRef } from "@t4-code/protocol";
import type { ProjectionSnapshot, SessionProjection } from "@t4-code/client";

export interface CompanionAttentionItem {
  readonly key: string;
  readonly session: SessionRef;
  readonly item: PendingAttentionItem;
  readonly title: string;
  readonly summary: string;
  readonly requestedAtMs: number;
}

export function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}

export function sessionsFrom(snapshot: ProjectionSnapshot): readonly SessionRef[] {
  return [...snapshot.sessionIndex.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export function attentionFrom(snapshot: ProjectionSnapshot): readonly CompanionAttentionItem[] {
  const result: CompanionAttentionItem[] = [];
  for (const session of snapshot.sessionIndex.values()) {
    for (const item of session.attention?.pending ?? []) {
      result.push({
        key: `${String(session.hostId)}:${String(session.sessionId)}:${item.kind}:${item.id}`,
        session,
        item,
        title: item.kind === "question" ? "Agent question" : item.kind === "plan" ? "Plan ready" : item.title,
        summary: item.kind === "question" ? item.question : item.summary,
        requestedAtMs: Date.parse(item.requestedAt),
      });
    }
  }
  return result.sort((left, right) => left.requestedAtMs - right.requestedAtMs);
}

export function warmSession(
  snapshot: ProjectionSnapshot,
  hostId: string,
  sessionId: string,
): SessionProjection | undefined {
  return snapshot.sessions.get(sessionKey(hostId, sessionId));
}

export function canWriteSession(session: SessionRef, attached = false): boolean {
	if (session.liveState?.sessionControl !== undefined) return false;
	// A live CLI session is read-only until session.attach has warmed its
	// transcript and the host has confirmed whether another process owns it.
	return session.status !== "active" || attached;
}

export function projectName(session: SessionRef): string {
  return session.project.name ?? String(session.project.projectId);
}

export function relativeTime(timestamp: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function entryText(data: Readonly<Record<string, unknown>>): string | null {
  const text = data.text;
  if (typeof text === "string" && text.trim() !== "") return text;
  const message = data.message;
  if (typeof message === "string" && message.trim() !== "") return message;
  return null;
}

export function entryRole(data: Readonly<Record<string, unknown>>): "You" | "Agent" | "Update" {
  if (data.role === "user") return "You";
  if (data.role === "assistant") return "Agent";
  return "Update";
}

export function transcriptDisplayState(
  finishedOpening: boolean,
  visibleEntryCount: number,
): "loading" | "empty" | "ready" {
  if (visibleEntryCount > 0) return "ready";
  return finishedOpening ? "empty" : "loading";
}
