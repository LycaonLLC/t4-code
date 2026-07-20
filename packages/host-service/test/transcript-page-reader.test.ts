import { describe, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeTranscriptPageResult,
	hostId,
	projectId,
	sessionId,
	TRANSCRIPT_PAGE_MAX_BYTES,
} from "@t4-code/host-wire";
import { FileSessionDiscovery } from "../src/discovery.ts";
import {
	TranscriptPageError,
	TranscriptPageReader,
	type TranscriptPageFileSystem,
} from "../src/transcript-page-reader.ts";
import type { SessionRecord } from "../src/types.ts";

const host = hostId("transcript-page-test");
const stamp = "2026-07-20T00:00:00.000Z";
const encoder = new TextEncoder();

function header(id = "page-session"): string {
	return `${JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp/page", timestamp: stamp })}\n`;
}

function message(id: string, index: number, text = `message ${index}`): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(Date.parse(stamp) + index).toISOString(),
		message: { role: "assistant", content: text },
	})}\n`;
}

function record(id = "page-session", path = "/history/page.jsonl"): SessionRecord {
	return {
		sessionId: sessionId(id),
		path,
		cwd: "/tmp/page",
		projectId: projectId("page-project"),
		title: "Paged transcript",
		updatedAt: stamp,
		status: "idle",
		entriesLoaded: false,
		entries: [],
	};
}

class MemoryPageFs implements TranscriptPageFileSystem {
	content: Uint8Array;
	ino = 7;
	readonly ranges: Array<{ offset: number; maxBytes: number }> = [];
	constructor(content: string) {
		this.content = encoder.encode(content);
	}
	async stat() {
		return {
			isFile: () => true,
			size: this.content.byteLength,
			mtimeMs: 1,
			ctimeMs: 1,
			dev: 2,
			ino: this.ino,
		};
	}
	async readFileSlice(_path: string, maxBytes: number) {
		return this.content.subarray(0, maxBytes);
	}
	async readFileRange(_path: string, offset: number, maxBytes: number, expectedIdentity?: string) {
		if (expectedIdentity !== undefined && expectedIdentity !== `2:${this.ino}`) throw new Error("identity changed");
		this.ranges.push({ offset, maxBytes });
		return this.content.subarray(offset, offset + maxBytes);
	}
	append(value: string): void {
		const suffix = encoder.encode(value);
		const next = new Uint8Array(this.content.byteLength + suffix.byteLength);
		next.set(this.content);
		next.set(suffix, this.content.byteLength);
		this.content = next;
	}
}

function texts(result: { entries: readonly { data: Record<string, unknown> }[] }): string[] {
	return result.entries.map(entry => String(entry.data.text ?? entry.data.toolCallId ?? ""));
}

describe("bounded backward transcript pages", () => {
	test("returns ordinary pages oldest-to-newest without overlap", async () => {
		const fs = new MemoryPageFs(
			header() + message("one", 1) + message("two", 2) + message("three", 3) + message("four", 4),
		);
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(1));
		const latest = await reader.page(record(), { limit: 2 });
		expect(texts(latest)).toEqual(["message 3", "message 4"]);
		expect(latest.hasMore).toBe(true);
		expect(latest.nextCursor).toBeDefined();
		expect(latest.nextCursor).not.toContain("/history/page.jsonl");
		expect(Buffer.from(latest.nextCursor!, "base64url").toString("utf8")).not.toContain("/history/page.jsonl");
		expect(decodeTranscriptPageResult(latest)).toEqual(latest);

		const older = await reader.page(record(), { before: latest.nextCursor, limit: 2 });
		expect(texts(older)).toEqual(["message 1", "message 2"]);
		expect(older.hasMore).toBe(false);
		expect(new Set([...latest.entries, ...older.entries].map(entry => entry.id)).size).toBe(4);
	});

	test("skips malformed and oversized JSONL records without losing nearby messages", async () => {
		const malformed = "{not-json}\n";
		const oversized = `${"x".repeat(1024 * 1024 + 1)}\n`;
		const fs = new MemoryPageFs(header() + message("before", 1) + malformed + oversized + message("after", 2));
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(8));
		const page = await reader.page(record(), { limit: 10 });
		expect(texts(page)).toEqual(["message 1", "message 2"]);
		expect(page.hasMore).toBe(false);
	});

	test("freezes a paging walk while new lines append", async () => {
		const fs = new MemoryPageFs(
			header() + message("one", 1) + message("two", 2) + message("three", 3) + message("four", 4),
		);
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(2));
		const latest = await reader.page(record(), { limit: 2 });
		fs.append(message("five", 5));
		const older = await reader.page(record(), { before: latest.nextCursor, limit: 2 });
		expect(texts(older)).toEqual(["message 1", "message 2"]);
		expect(older.generation).toBe(latest.generation);
		expect(texts(older)).not.toContain("message 5");

		const refreshed = await reader.page(record(), { limit: 1 });
		expect(texts(refreshed)).toEqual(["message 5"]);
		expect(refreshed.generation).toBe(latest.generation);
	});

	test("separates malformed cursors from stale file generations", async () => {
		const fs = new MemoryPageFs(header() + message("one", 1) + message("two", 2));
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(3));
		const latest = await reader.page(record(), { limit: 1 });
		const tampered = `${latest.nextCursor!.slice(0, -1)}${latest.nextCursor!.endsWith("A") ? "B" : "A"}`;
		await expect(reader.page(record(), { before: tampered })).rejects.toMatchObject({
			code: "transcript_cursor_invalid",
		});

		fs.ino += 1;
		await expect(reader.page(record(), { before: latest.nextCursor })).rejects.toMatchObject({
			code: "transcript_cursor_stale",
		});
		const replacement = await reader.page(record(), { limit: 1 });
		expect(replacement.generation).not.toBe(latest.generation);
	});

	test("detects in-place rewrites around a cursor boundary", async () => {
		const fs = new MemoryPageFs(header() + message("one", 1) + message("two", 2) + message("three", 3));
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(4));
		const latest = await reader.page(record(), { limit: 1 });
		const text = new TextDecoder().decode(fs.content).replace("message 2", "rewritten");
		fs.content = encoder.encode(text);
		await expect(reader.page(record(), { before: latest.nextCursor })).rejects.toMatchObject({
			code: "transcript_cursor_stale",
		});
	});

	test("keeps both the requested page and complete wire result byte bounded", async () => {
		const fs = new MemoryPageFs(header() + Array.from({ length: 20 }, (_, i) => message(`m-${i}`, i, "x".repeat(200))).join(""));
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(5));
		const page = await reader.page(record(), { limit: 128, maxBytes: 4 * 1024 });
		expect(encoder.encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(4 * 1024);
		expect(page.entries.length).toBeGreaterThan(0);
		expect(page.entries.length).toBeLessThan(20);
		expect(encoder.encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(TRANSCRIPT_PAGE_MAX_BYTES);
	});

	test("backscans across a tool call/result split", async () => {
		const toolCall = `${JSON.stringify({
			type: "message",
			id: "assistant-call",
			parentId: null,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "safe.txt" } }],
			},
		})}\n`;
		const ignored = `${JSON.stringify({
			type: "model_change",
			id: "padding",
			parentId: null,
			timestamp: stamp,
			model: "x".repeat(220 * 1024),
		})}\n`;
		const result = `${JSON.stringify({
			type: "message",
			id: "tool-result",
			parentId: "assistant-call",
			timestamp: new Date(Date.parse(stamp) + 1).toISOString(),
			message: { role: "toolResult", toolCallId: "call-1", content: "file contents" },
		})}\n`;
		const prefixBytes = encoder.encode(header() + toolCall + ignored).byteLength;
		const paddingTarget = 8 * 1024 * 1024 + 64 * 1024;
		const paddingLines = Math.ceil(Math.max(0, paddingTarget - prefixBytes) / 128);
		const padding = Array.from({ length: paddingLines }, (_, i) =>
			`${JSON.stringify({ type: "model_change", id: `p-${i}`, parentId: null, timestamp: stamp, model: "none" })}\n`,
		).join("");
		const fs = new MemoryPageFs(header() + toolCall + ignored + padding + result);
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(6));
		const page = await reader.page(record(), { limit: 1 });
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]).toMatchObject({ kind: "tool-use", data: { toolCallId: "call-1" } });
		expect(fs.ranges.every(read => read.maxBytes <= 8.5 * 1024 * 1024)).toBe(true);
	}, 20_000);

	test("reads a cold tail from a sparse transcript larger than 64 MiB", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-transcript-page-sparse-"));
		const path = join(root, "large.jsonl");
		const handle = await open(path, "w+");
		try {
			await handle.write(header("large-session"), 0, "utf8");
			const tailOffset = 70 * 1024 * 1024;
			await handle.truncate(tailOffset);
			await handle.write(`\n${message("tail", 1, "cold tail")}`, tailOffset, "utf8");
			await handle.close();
			const discovery = new FileSessionDiscovery(root, undefined, host);
			const [session] = await discovery.list();
			if (!session) throw new Error("missing sparse session");
			if (!discovery.page) throw new Error("missing bounded transcript reader");
			const page = await discovery.page(session, { limit: 10 });
			expect(texts(page)).toEqual(["cold tail"]);
			expect(page.hasMore).toBe(true);
		} finally {
			await handle.close().catch(() => undefined);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails explicitly when one entry cannot fit the requested byte budget", async () => {
		const fs = new MemoryPageFs(header() + message("large", 1, "z".repeat(8 * 1024)));
		const reader = new TranscriptPageReader(host, fs, new Uint8Array(32).fill(7));
		await expect(reader.page(record(), { maxBytes: 1024 })).rejects.toBeInstanceOf(TranscriptPageError);
	});
});
