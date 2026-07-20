import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import { controlFree, inputObject } from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
export interface GapFrame {
	v: typeof PROTOCOL_VERSION;
	type: "gap";
	hostId: HostId;
	sessionId: SessionId;
	from: Cursor;
	to: Cursor;
	reason: string;
}
export function decodeGap(input: unknown): GapFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "gap") fail("INVALID_FRAME", "expected gap frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	const from = decodeCursor(frame.from, "from");
	const to = decodeCursor(frame.to, "to");
	if (from.epoch !== to.epoch || to.seq < from.seq) fail("INVALID_FRAME", "gap cursor range is invalid", "to");
	controlFree(frame.reason, "reason", 256);
	return { ...frame, from, to } as unknown as GapFrame;
}
