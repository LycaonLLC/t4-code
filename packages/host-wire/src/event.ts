import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import { boundedMap, controlFree, inputObject } from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
export interface SessionEvent {
	type: string;
	[key: string]: unknown;
}
export interface LiveEventFrame {
	v: typeof PROTOCOL_VERSION;
	type: "event";
	cursor: Cursor;
	hostId: HostId;
	sessionId: SessionId;
	event: SessionEvent;
}
export function decodeEvent(input: unknown): LiveEventFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "event") fail("INVALID_FRAME", "expected event frame", "type");
	const cursor = decodeCursor(frame.cursor);
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	const event = boundedMap(frame.event, "event");
	controlFree(event.type, "event.type", 128);
	return { ...frame, cursor, event } as unknown as LiveEventFrame;
}
export function isSessionEvent(value: unknown): value is SessionEvent {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Record<string, unknown>;
	return typeof event.type === "string" && event.type.length > 0 && event.type.length <= 128;
}
