import { decodeCommandResult } from "./command.js";
import { fail } from "./errors.js";
import { boundedMap, controlFree, inputObject, string } from "./guards.js";
import {
	type CommandId,
	commandId,
	type HostId,
	hostId,
	type RequestId,
	requestId,
	type SessionId,
	sessionId,
} from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
export interface ResultError {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}
export interface ResultFrame {
	v: typeof PROTOCOL_VERSION;
	type: "response";
	requestId: RequestId;
	commandId?: CommandId;
	hostId: HostId;
	sessionId?: SessionId;
	ok: boolean;
	result?: unknown;
	command?: string;
	error?: ResultError;
}
export function decodeResult(input: unknown): ResultFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "response") fail("INVALID_FRAME", "expected response frame", "type");
	requestId(frame.requestId);
	if (frame.commandId !== undefined) commandId(frame.commandId);
	hostId(frame.hostId);
	if (frame.sessionId !== undefined) sessionId(frame.sessionId);
	if (typeof frame.ok !== "boolean") fail("INVALID_FRAME", "ok must be boolean", "ok");
	if (frame.ok) {
		if (frame.error !== undefined) fail("INVALID_FRAME", "successful response cannot have error", "error");
	} else {
		if (frame.result !== undefined) fail("INVALID_FRAME", "failed response cannot have result", "result");
		const error = boundedMap(frame.error, "error");
		controlFree(error.code, "error.code", 128);
		string(error.message, "error.message", 1024);
		if (error.details !== undefined) {
			const details = boundedMap(error.details, "error.details");
			if (error.code === "idempotency_conflict") {
				controlFree(details.commandId, "error.details.commandId", 256);
				controlFree(details.payloadHash, "error.details.payloadHash", 256);
			} else if (error.code === "stale_revision") {
				controlFree(details.expectedRevision, "error.details.expectedRevision", 256);
				controlFree(details.actualRevision, "error.details.actualRevision", 256);
			} else if (error.code === "outcome_unknown") controlFree(details.recovery, "error.details.recovery", 1024);
		}
	}
	if (frame.command !== undefined) {
		const command = controlFree(frame.command, "command", 128);
		if (frame.ok)
			return { ...frame, command, result: decodeCommandResult(command, frame.result) } as unknown as ResultFrame;
	}
	if (frame.ok && frame.result !== undefined)
		fail("INVALID_FRAME", "successful response result requires a typed command", "command");
	return frame as unknown as ResultFrame;
}
