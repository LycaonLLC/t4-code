import {
	type AdditiveServerFrame,
	decodeAdditiveServerFrame,
	decodeTerminalClient,
	type TerminalClientFrame,
} from "./additive.js";
import { type AgentFrame, decodeAgent } from "./agents.js";
import { type AuditFrame, decodeAudit } from "./audit.js";
import { type CommandFrame, decodeCommand } from "./command.js";
import { type Cursor, decodeCursor } from "./cursor.js";
import { type DurableEntry, decodeEntry } from "./entry.js";
import { fail } from "./errors.js";
import { decodeEvent, type LiveEventFrame } from "./event.js";
import { decodeFiles, decodeReview, type FileFrame, type ReviewFrame } from "./files-review.js";
import { decodeGap, type GapFrame } from "./gap.js";
import { controlFree, inputObject } from "./guards.js";
import { type ByeFrame, decodeBye, decodePing, decodePong, type PingFrame, type PongFrame } from "./heartbeat.js";
import { decodeHello, decodeWelcome, type HelloFrame, type WelcomeFrame } from "./hello.js";
import { type HostId, hostId, type Revision, revision, type SessionId, sessionId } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
import {
	type ConfirmationChallenge,
	type ConfirmFrame,
	decodeConfirm,
	decodeConfirmation,
	decodePairing,
	type PairingFrame,
	type PairStartFrame,
} from "./pairing-confirm.js";
import { decodeResult, type ResultFrame } from "./result.js";
import { decodeSessions, type SessionsFrame } from "./session-index.js";
import { decodeSnapshot, type SessionSnapshotFrame } from "./snapshot.js";
import { decodeTerminal, type TerminalFrame } from "./terminal.js";
export interface ErrorFrame {
	v: typeof PROTOCOL_VERSION;
	type: "error";
	code: string;
	message: string;
	requestId?: string;
}
export interface DurableEntryFrame {
	v: typeof PROTOCOL_VERSION;
	type: "entry";
	cursor: Cursor;
	revision: Revision;
	hostId: HostId;
	sessionId: SessionId;
	entry: DurableEntry;
}
export type ClientFrame = HelloFrame | CommandFrame | ConfirmFrame | PairStartFrame | PingFrame | TerminalClientFrame;
export type ServerFrame =
	| WelcomeFrame
	| SessionsFrame
	| SessionSnapshotFrame
	| DurableEntryFrame
	| LiveEventFrame
	| AgentFrame
	| TerminalFrame
	| FileFrame
	| ReviewFrame
	| AuditFrame
	| PairingFrame
	| ConfirmationChallenge
	| ResultFrame
	| GapFrame
	| ErrorFrame
	| PongFrame
	| ByeFrame
	| AdditiveServerFrame;
export type AppFrame = ClientFrame | ServerFrame;
function decodeError(input: unknown): ErrorFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "error") fail("INVALID_FRAME", "expected error frame", "type");
	controlFree(frame.code, "code", 128);
	controlFree(frame.message, "message", 2048);
	if (frame.requestId !== undefined) controlFree(frame.requestId, "requestId", 256);
	return frame as unknown as ErrorFrame;
}
export function decodeDurableEntryFrame(input: unknown): DurableEntryFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "entry") fail("INVALID_FRAME", "expected durable entry frame", "type");
	const cursor = decodeCursor(frame.cursor);
	const currentRevision = revision(frame.revision);
	const host = hostId(frame.hostId);
	const session = sessionId(frame.sessionId);
	const entry = decodeEntry(frame.entry);
	if (entry.hostId !== host || entry.sessionId !== session)
		fail("INVALID_FRAME", "entry belongs to another session", "entry");
	return { ...frame, cursor, revision: currentRevision, entry } as unknown as DurableEntryFrame;
}
export function decodeClientFrame(input: unknown): ClientFrame {
	const frame = inputObject(input);
	switch (frame.type) {
		case "hello":
			return decodeHello(frame);
		case "command":
			return decodeCommand(frame);
		case "confirm":
			return decodeConfirm(frame);
		case "pair.start":
			return decodePairing(frame) as PairStartFrame;
		case "ping":
			return decodePing(frame);
		case "terminal.input":
		case "terminal.resize":
		case "terminal.close":
			return decodeTerminalClient(frame);
		default:
			fail("UNKNOWN_FRAME", "unknown client frame family", "type");
	}
}
export function decodeServerFrame(input: unknown): ServerFrame {
	const frame = inputObject(input);
	switch (frame.type) {
		case "welcome":
			return decodeWelcome(frame);
		case "sessions":
			return decodeSessions(frame);
		case "snapshot":
			return decodeSnapshot(frame);
		case "entry":
			return decodeDurableEntryFrame(frame);
		case "event":
			return decodeEvent(frame);
		case "agent":
			return decodeAgent(frame);
		case "terminal":
			return decodeTerminal(frame);
		case "files":
			return decodeFiles(frame);
		case "review":
			return decodeReview(frame);
		case "audit":
			return decodeAudit(frame);
		case "pair.ok":
		case "pair.error":
			return decodePairing(frame);
		case "confirmation":
			return decodeConfirmation(frame);
		case "response":
			return decodeResult(frame);
		case "gap":
			return decodeGap(frame);
		case "error":
			return decodeError(frame);
		case "pong":
			return decodePong(frame);
		case "bye":
			return decodeBye(frame);
		default:
			return decodeAdditiveServerFrame(frame);
	}
}
export function isClientFrame(value: unknown): value is ClientFrame {
	try {
		decodeClientFrame(value);
		return true;
	} catch {
		return false;
	}
}
export function isServerFrame(value: unknown): value is ServerFrame {
	try {
		decodeServerFrame(value);
		return true;
	} catch {
		return false;
	}
}
