import { fail } from "./errors.js";
import { controlFree, inputObject } from "./guards.js";
import { PROTOCOL_VERSION } from "./limits.js";
export interface PingFrame {
	v: typeof PROTOCOL_VERSION;
	type: "ping";
	nonce: string;
	timestamp: string;
}
export interface PongFrame {
	v: typeof PROTOCOL_VERSION;
	type: "pong";
	nonce: string;
	timestamp: string;
}
export interface ByeFrame {
	v: typeof PROTOCOL_VERSION;
	type: "bye";
	code: string;
	reason: string;
	retryable: boolean;
}
function base(input: unknown, type: string): Record<string, unknown> {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== type) fail("INVALID_FRAME", `expected ${type} frame`, "type");
	return frame;
}
export function decodePing(input: unknown): PingFrame {
	const frame = base(input, "ping");
	controlFree(frame.nonce, "nonce", 128);
	controlFree(frame.timestamp, "timestamp", 128);
	return frame as unknown as PingFrame;
}
export function decodePong(input: unknown): PongFrame {
	const frame = base(input, "pong");
	controlFree(frame.nonce, "nonce", 128);
	controlFree(frame.timestamp, "timestamp", 128);
	return frame as unknown as PongFrame;
}
export function decodeBye(input: unknown): ByeFrame {
	const frame = base(input, "bye");
	controlFree(frame.code, "code", 128);
	controlFree(frame.reason, "reason", 1024);
	if (typeof frame.retryable !== "boolean") fail("INVALID_FRAME", "retryable must be boolean", "retryable");
	return frame as unknown as ByeFrame;
}
