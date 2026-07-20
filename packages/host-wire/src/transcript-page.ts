import { type DurableEntry, decodeEntry } from "./entry.js";
import { fail } from "./errors.js";
import { boundedArray, boundedMap, controlFree, safeSeq, utf8ByteLength } from "./guards.js";

export const TRANSCRIPT_PAGE_MAX_ENTRIES = 128;
export const TRANSCRIPT_PAGE_MAX_CURSOR_BYTES = 2_048;
export const TRANSCRIPT_PAGE_MAX_GENERATION_BYTES = 128;
export const TRANSCRIPT_PAGE_MIN_BYTES = 1_024;
export const TRANSCRIPT_PAGE_MAX_BYTES = 512 * 1_024;
export const TRANSCRIPT_PAGE_MAX_RESULT_BYTES = TRANSCRIPT_PAGE_MAX_BYTES;

export interface TranscriptPageArguments {
	readonly before?: string;
	readonly limit?: number;
	readonly maxBytes?: number;
}

export interface TranscriptPageResult {
	readonly entries: readonly DurableEntry[];
	readonly nextCursor?: string;
	readonly hasMore: boolean;
	readonly generation: string;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const expected = new Set(allowed);
	for (const key of Object.keys(value))
		if (!expected.has(key)) fail("INVALID_FRAME", "unknown transcript page field", `${path}.${key}`);
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
	const integer = safeSeq(value, path);
	if (integer < min || integer > max) fail("BOUNDS", `integer must be between ${min} and ${max}`, path);
	return integer;
}

export function decodeTranscriptPageArguments(value: unknown): TranscriptPageArguments {
	const input = boundedMap(value, "args");
	exactKeys(input, ["before", "limit", "maxBytes"], "args");
	const before =
		input.before === undefined ? undefined : controlFree(input.before, "args.before", TRANSCRIPT_PAGE_MAX_CURSOR_BYTES);
	const limit =
		input.limit === undefined ? undefined : boundedInteger(input.limit, "args.limit", 1, TRANSCRIPT_PAGE_MAX_ENTRIES);
	const maxBytes =
		input.maxBytes === undefined
			? undefined
			: boundedInteger(input.maxBytes, "args.maxBytes", TRANSCRIPT_PAGE_MIN_BYTES, TRANSCRIPT_PAGE_MAX_BYTES);
	return {
		...(before === undefined ? {} : { before }),
		...(limit === undefined ? {} : { limit }),
		...(maxBytes === undefined ? {} : { maxBytes }),
	};
}

function decodePageEntry(value: unknown, path: string): DurableEntry {
	const input = boundedMap(value, path);
	exactKeys(input, ["id", "parentId", "hostId", "sessionId", "turnId", "kind", "timestamp", "data"], path);
	return decodeEntry(input);
}

function serializedBytes(value: unknown): number {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		fail("INVALID_FRAME", "transcript page result must be JSON serializable", "result");
	}
	return utf8ByteLength(encoded);
}

export function decodeTranscriptPageResult(value: unknown): TranscriptPageResult {
	const input = boundedMap(value, "result");
	exactKeys(input, ["entries", "nextCursor", "hasMore", "generation"], "result");
	const entries = boundedArray(input.entries, "result.entries", TRANSCRIPT_PAGE_MAX_ENTRIES).map((entry, index) =>
		decodePageEntry(entry, `result.entries[${index}]`),
	);
	for (let index = 0; index < entries.length; index++) {
		const timestamp = Date.parse(entries[index]!.timestamp);
		if (!Number.isFinite(timestamp))
			fail(
				"INVALID_FRAME",
				"transcript page entry timestamp must be ISO-compatible",
				`result.entries[${index}].timestamp`,
			);
	}
	const nextCursor =
		input.nextCursor === undefined
			? undefined
			: controlFree(input.nextCursor, "result.nextCursor", TRANSCRIPT_PAGE_MAX_CURSOR_BYTES);
	if (typeof input.hasMore !== "boolean") fail("INVALID_FRAME", "hasMore must be boolean", "result.hasMore");
	if (input.hasMore !== (nextCursor !== undefined))
		fail("INVALID_FRAME", "nextCursor must be present exactly when hasMore is true", "result.nextCursor");
	const generation = controlFree(input.generation, "result.generation", TRANSCRIPT_PAGE_MAX_GENERATION_BYTES);
	const result: TranscriptPageResult = {
		entries,
		...(nextCursor === undefined ? {} : { nextCursor }),
		hasMore: input.hasMore,
		generation,
	};
	if (serializedBytes(result) > TRANSCRIPT_PAGE_MAX_RESULT_BYTES)
		fail("BOUNDS", "transcript page result exceeds its wire budget", "result");
	return result;
}
