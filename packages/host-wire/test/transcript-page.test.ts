import { expect, test } from "bun:test";
import {
	ADDITIVE_FEATURES,
	AppWireError,
	COMMAND_DESCRIPTORS,
	decodeClientFrame,
	decodeServerFrame,
	decodeTranscriptPageArguments,
	decodeTranscriptPageResult,
	PROTOCOL_FEATURES,
	TRANSCRIPT_PAGE_MAX_BYTES,
	TRANSCRIPT_PAGE_MAX_CURSOR_BYTES,
	TRANSCRIPT_PAGE_MAX_ENTRIES,
	TRANSCRIPT_PAGE_MAX_GENERATION_BYTES,
	TRANSCRIPT_PAGE_MAX_RESULT_BYTES,
	TRANSCRIPT_PAGE_MIN_BYTES,
} from "../src/index.js";

const root = new URL("./fixtures/transcript-page/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await Bun.file(new URL(name, root)).text()) as unknown;
}

async function decodeServerOrClient(name: string): Promise<void> {
	const value = await fixture(name);
	const frame = value as { type?: unknown };
	if (frame.type === "command") decodeClientFrame(value);
	else decodeServerFrame(value);
}

test("transcript page golden request and response decode through the public wire boundary", async () => {
	expect(decodeClientFrame(await fixture("transcript-page-request.json")).type).toBe("command");
	expect(decodeServerFrame(await fixture("transcript-page-response.json")).type).toBe("response");
	for (const name of [
		"transcript-page-limit.invalid.json",
		"transcript-page-max-bytes.invalid.json",
		"transcript-page-timestamp.invalid.json",
	])
		await expect(decodeServerOrClient(name)).rejects.toBeInstanceOf(AppWireError);
});

test("transcript page is negotiated and session-scoped without revision or confirmation", () => {
	expect(PROTOCOL_FEATURES).toContain("transcript.page");
	expect(ADDITIVE_FEATURES).toContain("transcript.page");
	expect(COMMAND_DESCRIPTORS["transcript.page"]).toEqual({
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	});
});

test("transcript page arguments are optional, exact, and bounded", () => {
	expect(decodeTranscriptPageArguments({})).toEqual({});
	expect(
		decodeTranscriptPageArguments({
			before: "opaque",
			limit: TRANSCRIPT_PAGE_MAX_ENTRIES,
			maxBytes: TRANSCRIPT_PAGE_MAX_BYTES,
		}),
	).toEqual({
		before: "opaque",
		limit: TRANSCRIPT_PAGE_MAX_ENTRIES,
		maxBytes: TRANSCRIPT_PAGE_MAX_BYTES,
	});
	for (const invalid of [
		{ before: "" },
		{ before: "x".repeat(TRANSCRIPT_PAGE_MAX_CURSOR_BYTES + 1) },
		{ limit: 0 },
		{ limit: TRANSCRIPT_PAGE_MAX_ENTRIES + 1 },
		{ maxBytes: TRANSCRIPT_PAGE_MIN_BYTES - 1 },
		{ maxBytes: TRANSCRIPT_PAGE_MAX_BYTES + 1 },
		{ cursor: "not-the-contract" },
	])
		expect(() => decodeTranscriptPageArguments(invalid)).toThrow(AppWireError);
});

const firstEntry = {
	id: "entry-1",
	parentId: null,
	hostId: "host-a",
	sessionId: "session-a",
	kind: "message",
	timestamp: "2026-07-18T11:58:00.000Z",
	data: { role: "user", text: "First" },
};
const secondEntry = {
	id: "entry-2",
	parentId: "entry-1",
	hostId: "host-a",
	sessionId: "session-a",
	kind: "message",
	timestamp: "2026-07-18T11:59:00.000Z",
	data: { role: "assistant", text: "Second" },
};

test("transcript page results are exact, timestamp-valid, and cursor-consistent", () => {
	const result = {
		entries: [firstEntry, secondEntry],
		nextCursor: "older-page",
		hasMore: true,
		generation: "generation-1",
	};
	expect(decodeTranscriptPageResult(result)).toEqual(result);
	for (const invalid of [
		{ ...result, hidden: true },
		{ ...result, entries: [{ ...firstEntry, rawPath: "/private/transcript.jsonl" }] },
		{ ...result, entries: [{ ...firstEntry, timestamp: "yesterday" }] },
		{
			...result,
			entries: Array.from({ length: TRANSCRIPT_PAGE_MAX_ENTRIES + 1 }, () => firstEntry),
		},
		{ ...result, nextCursor: undefined, hasMore: true },
		{ ...result, hasMore: false },
		{ ...result, generation: "x".repeat(TRANSCRIPT_PAGE_MAX_GENERATION_BYTES + 1) },
	])
		expect(() => decodeTranscriptPageResult(invalid)).toThrow(AppWireError);

	expect(decodeTranscriptPageResult({ entries: [], hasMore: false, generation: "generation-1" })).toEqual({
		entries: [],
		hasMore: false,
		generation: "generation-1",
	});
	expect(decodeTranscriptPageResult({ ...result, entries: [secondEntry, firstEntry] })).toMatchObject({
		entries: [secondEntry, firstEntry],
	});
});

test("transcript page results have a total serialized byte budget", () => {
	const oversized = {
		entries: Array.from({ length: 9 }, (_, index) => ({
			...firstEntry,
			id: `entry-${index}`,
			data: { text: "x".repeat(65_536) },
		})),
		hasMore: false,
		generation: "generation-1",
	};
	expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
		TRANSCRIPT_PAGE_MAX_RESULT_BYTES,
	);
	expect(() => decodeTranscriptPageResult(oversized)).toThrow(AppWireError);
});
