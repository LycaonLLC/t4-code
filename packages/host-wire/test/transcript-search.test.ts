import { expect, test } from "bun:test";
import {
	ADDITIVE_FEATURES,
	AppWireError,
	COMMAND_DESCRIPTORS,
	decodeClientFrame,
	decodeServerFrame,
	decodeTranscriptContextArguments,
	decodeTranscriptContextResult,
	decodeTranscriptSearchArguments,
	decodeTranscriptSearchResult,
	PROTOCOL_FEATURES,
	TRANSCRIPT_CONTEXT_MAX_ROWS,
	TRANSCRIPT_SEARCH_MAX_HIGHLIGHTS,
	TRANSCRIPT_SEARCH_MAX_RESULTS,
} from "../src/index.js";

const root = new URL("../fixtures/v1/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await Bun.file(new URL(name, root)).text()) as unknown;
}

test("transcript search golden requests and responses decode through the public wire boundary", async () => {
	for (const name of ["transcript-search-request.json", "transcript-context-request.json"])
		expect(decodeClientFrame(await fixture(name)).type).toBe("command");
	for (const name of ["transcript-search-response.json", "transcript-context-response.json"])
		expect(decodeServerFrame(await fixture(name)).type).toBe("response");
	for (const name of ["transcript-search-limit.invalid.json", "transcript-context-anchor.invalid.json"])
		await expect(decodeServerOrClient(name)).rejects.toBeInstanceOf(AppWireError);
});

async function decodeServerOrClient(name: string): Promise<void> {
	const value = await fixture(name);
	const frame = value as { type?: unknown };
	if (frame.type === "command") decodeClientFrame(value);
	else decodeServerFrame(value);
}

test("transcript search descriptors and negotiated feature match the frozen authority contract", () => {
	expect(PROTOCOL_FEATURES).toContain("transcript.search");
	expect(ADDITIVE_FEATURES).toContain("transcript.search");
	expect(COMMAND_DESCRIPTORS["transcript.search"]).toEqual({
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	});
	expect(COMMAND_DESCRIPTORS["transcript.context"]).toEqual({
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	});
});

test("transcript search arguments are strict, literal, byte-bounded, and internally consistent", () => {
	expect(decodeTranscriptSearchArguments({ query: "SQLite FTS5" })).toEqual({ query: "SQLite FTS5" });
	for (const invalid of [
		{},
		{ query: " \t " },
		{ query: "x", limit: 0 },
		{ query: "x", limit: 51 },
		{ query: "x", roles: [] },
		{ query: "x", roles: ["user", "user"] },
		{ query: "x", roles: ["tool"] },
		{ query: "x", archived: "all" },
		{ query: "x", from: "2026-07-18T00:00:00Z" },
		{ query: "x", from: "2026-07-19T00:00:00.000Z", to: "2026-07-18T00:00:00.000Z" },
		{ query: "x", rawPath: "/private/session.jsonl" },
		{ query: "😀".repeat(129) },
	])
		expect(() => decodeTranscriptSearchArguments(invalid)).toThrow(AppWireError);
});

test("transcript search results reject oversized, unsafe, and hidden shapes", () => {
	const item = {
		sessionId: "s",
		projectId: "p",
		sessionTitle: "Title",
		anchorId: "entry-1",
		role: "assistant",
		timestamp: "2026-07-18T00:00:00.000Z",
		snippet: "matched text",
		highlights: [{ start: 0, end: 7 }],
	};
	const result = {
		items: [item],
		incomplete: false,
		index: { state: "ready", indexedSessions: 1, knownSessions: 1, generation: "g1" },
	};
	expect(decodeTranscriptSearchResult(result)).toEqual(result);
	for (const invalid of [
		{ ...result, items: Array.from({ length: TRANSCRIPT_SEARCH_MAX_RESULTS + 1 }, () => item) },
		{ ...result, items: [{ ...item, highlights: [{ start: 4, end: 4 }] }] },
		{ ...result, items: [{ ...item, highlights: [{ start: 0, end: item.snippet.length + 1 }] }] },
		{
			...result,
			items: [
				{
					...item,
					highlights: Array.from({ length: TRANSCRIPT_SEARCH_MAX_HIGHLIGHTS + 1 }, () => ({ start: 0, end: 1 })),
				},
			],
		},
		{ ...result, index: { ...result.index, indexedSessions: 2 } },
		{ ...result, query: "must-not-echo" },
		{ ...result, items: [{ ...item, reasoning: "hidden" }] },
	])
		expect(() => decodeTranscriptSearchResult(invalid)).toThrow(AppWireError);
});

test("transcript context is strict and anchors a bounded historical window", () => {
	expect(decodeTranscriptContextArguments({ anchorId: "entry-2", before: 0, after: 20 })).toEqual({
		anchorId: "entry-2",
		before: 0,
		after: 20,
	});
	for (const invalid of [
		{},
		{ anchorId: "entry", before: -1 },
		{ anchorId: "entry", after: 21 },
		{ anchorId: "entry", toolResults: true },
	])
		expect(() => decodeTranscriptContextArguments(invalid)).toThrow(AppWireError);

	const row = {
		anchorId: "entry-2",
		role: "assistant",
		timestamp: "2026-07-18T00:00:00.000Z",
		text: "Context",
	};
	const result = {
		anchorId: "entry-2",
		rows: [row],
		anchorIndex: 0,
		hasBefore: false,
		hasAfter: false,
		generation: "g1",
	};
	expect(decodeTranscriptContextResult(result)).toEqual(result);
	for (const invalid of [
		{ ...result, rows: [] },
		{ ...result, rows: [{ ...row, anchorId: "other" }] },
		{ ...result, rows: Array.from({ length: TRANSCRIPT_CONTEXT_MAX_ROWS + 1 }, () => row) },
		{ ...result, anchorIndex: 1 },
		{ ...result, rows: [{ ...row, rawTool: "hidden" }] },
	])
		expect(() => decodeTranscriptContextResult(invalid)).toThrow(AppWireError);
});
