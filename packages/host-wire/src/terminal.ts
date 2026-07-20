import { fail } from "./errors.js";
import { boundedText, controlFree, inputObject } from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId, type TerminalId, terminalId } from "./ids.js";
import { MAX_TERMINAL_OUTPUT_BYTES, PROTOCOL_VERSION } from "./limits.js";

interface LegacyTerminalBaseFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
}
export interface LegacyTerminalOutputFrame extends LegacyTerminalBaseFrame {
	stream: "stdout" | "stderr";
	data: string;
	exitCode?: never;
}
export interface LegacyTerminalExitFrame extends LegacyTerminalBaseFrame {
	stream: "exit";
	data?: never;
	exitCode: number;
}
export type TerminalFrame = LegacyTerminalOutputFrame | LegacyTerminalExitFrame;
export function decodeTerminal(input: unknown): TerminalFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "terminal") fail("INVALID_FRAME", "expected terminal frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	terminalId(frame.terminalId);
	const stream = controlFree(frame.stream, "stream", 32);
	if (stream === "stdout" || stream === "stderr") {
		boundedText(frame.data, "data", MAX_TERMINAL_OUTPUT_BYTES);
		if (frame.exitCode !== undefined) fail("INVALID_FRAME", "terminal output cannot have exitCode", "exitCode");
	} else if (stream === "exit") {
		if (frame.data !== undefined) fail("INVALID_FRAME", "terminal exit cannot have data", "data");
		if (typeof frame.exitCode !== "number" || !Number.isSafeInteger(frame.exitCode))
			fail("INVALID_FRAME", "exitCode must be safe integer", "exitCode");
	} else fail("INVALID_FRAME", "unknown terminal stream", "stream");
	return frame as unknown as TerminalFrame;
}
