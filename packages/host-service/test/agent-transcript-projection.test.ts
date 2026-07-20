import { describe, expect, test } from "bun:test";
import {
	type AgentTranscriptFrame,
	type DurableEntry,
	decodeServerFrame,
	entryId,
	hostId,
	revision,
	sessionId,
} from "@t4-code/host-wire";
import type { RpcSubagentMessagesResult } from "../src/omp-rpc-contract.ts";
import { AgentTranscriptProjection } from "../src/agent-transcript-projection.ts";

const host = hostId("agent-transcript-test-host");
const session = sessionId("agent-transcript-test-session");
const currentRevision = revision("agent-transcript-test-revision");
const encoder = new TextEncoder();

function transcriptEntries(...entries: Record<string, unknown>[]): RpcSubagentMessagesResult["entries"] {
	return entries as unknown as RpcSubagentMessagesResult["entries"];
}

function transcriptResult(
	fromByte: number,
	nextByte: number,
	entries: RpcSubagentMessagesResult["entries"] = [],
	reset = false,
): RpcSubagentMessagesResult {
	return {
		sessionFile: "/home/tester/private/subagent.jsonl",
		fromByte,
		nextByte,
		reset,
		entries,
		messages: [],
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for agent transcript projection");
		await Bun.sleep(1);
	}
}

function entriesBytes(entries: readonly DurableEntry[]): number {
	return entries.reduce((total, entry) => total + encoder.encode(JSON.stringify(entry)).byteLength, 0);
}

describe("AgentTranscriptProjection", () => {
	test("joins a tool call and structured result split across transcript reads", async () => {
		const imageSha = "e".repeat(64);
		const embeddedImage = `iVBORw0KGgo${"A".repeat(4_096)}`;
		const results = [
			transcriptResult(
				0,
				100,
				transcriptEntries({
					type: "message",
					id: "assistant-call",
					parentId: null,
					timestamp: "2026-07-15T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "read-call",
								name: "read",
								arguments: { path: "/home/tester/private/source.ts" },
							},
						],
					},
				}),
			),
			transcriptResult(
				100,
				200,
				transcriptEntries({
					type: "message",
					id: "read-result",
					parentId: "assistant-call",
					timestamp: "2026-07-15T00:00:01.000Z",
					message: {
						role: "toolResult",
						toolCallId: "read-call",
						toolName: "read",
						content: [{ type: "text", text: "contents from /home/tester/private/source.ts" }],
						details: {
							resolvedPath: "/home/tester/private/source.ts",
							preview: embeddedImage,
							authorization: "Bearer should-not-survive",
							images: [
								{ type: "image", mimeType: "image/png", data: embeddedImage, appImageSha256: imageSha },
								{ type: "image", mimeType: "image/png", data: embeddedImage, appImageSha256: imageSha },
							],
						},
						isError: false,
					},
				}),
			),
			transcriptResult(200, 200),
		];
		const reads: number[] = [];
		const emitted: AgentTranscriptFrame[] = [];
		const projection = new AgentTranscriptProjection({
			hostId: host,
			sessionId: session,
			epoch: "parent-epoch",
			read: async (agent, fromByte) => {
				expect(agent).toBe("WorkerA");
				reads.push(fromByte);
				return results.shift() ?? transcriptResult(fromByte, fromByte);
			},
			revision: () => currentRevision,
			emit: frame => emitted.push(frame),
		});

		projection.refresh("WorkerA");
		await waitUntil(() => reads.length === 3);

		expect(reads).toEqual([0, 100, 200]);
		expect(emitted).toHaveLength(1);
		const decoded = decodeServerFrame(emitted[0]);
		expect(decoded.type).toBe("agent.transcript");
		if (decoded.type !== "agent.transcript") throw new Error("expected agent transcript frame");
		expect(decoded).toMatchObject({
			agentId: "WorkerA",
			cursor: { seq: 1 },
			entries: [
				{
					kind: "tool-use",
					data: {
						tool: "read",
						args: { path: "[path]" },
						ok: true,
						result: {
							output: "contents from [path]",
							content: [{ type: "text", text: "contents from [path]" }],
							details: { resolvedPath: "[path]", preview: "[image omitted]" },
							isError: false,
						},
						images: [{ sha256: imageSha, mimeType: "image/png" }],
					},
				},
			],
			revision: currentRevision,
		});
		const serialized = JSON.stringify(decoded);
		expect(serialized).not.toContain(embeddedImage);
		expect(serialized).not.toContain("authorization");
		expect(serialized).not.toContain("/home/tester");
		const result = decoded.entries[0]?.data.result as Record<string, unknown> | undefined;
		const details = result?.details as Record<string, unknown> | undefined;
		expect(details).not.toHaveProperty("images");
	});

	test("authorizes only matching image metadata retained by the current child transcript", async () => {
		const imageSha = "a".repeat(64);
		const results = [
			transcriptResult(
				0,
				100,
				transcriptEntries({
					type: "message",
					id: "child-image",
					parentId: null,
					timestamp: "2026-07-15T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "child image" },
							{
								type: "image",
								mimeType: "image/png",
								data: `blob:sha256:${imageSha}`,
								appImageSha256: imageSha,
							},
						],
					},
				}),
			),
			transcriptResult(100, 100),
		];
		const reads: number[] = [];
		const emitted: AgentTranscriptFrame[] = [];
		const projection = new AgentTranscriptProjection({
			hostId: host,
			sessionId: session,
			epoch: "parent-epoch",
			read: async (_agent, fromByte) => {
				reads.push(fromByte);
				return results.shift() ?? transcriptResult(fromByte, fromByte);
			},
			revision: () => currentRevision,
			emit: frame => emitted.push(frame),
		});

		projection.refresh("WorkerA");
		await waitUntil(() => reads.length === 2);

		expect(projection.transcriptImage(entryId("child-image"), imageSha)).toEqual({
			sha256: imageSha,
			mimeType: "image/png",
		});
		expect(projection.transcriptImage(entryId("child-image"), "b".repeat(64))).toBeUndefined();
		expect(projection.transcriptImage(entryId("another-entry"), imageSha)).toBeUndefined();

		results.push(transcriptResult(0, 0, [], true));
		projection.refresh("WorkerA");
		await waitUntil(() => emitted.length === 2);
		expect(projection.transcriptImage(entryId("child-image"), imageSha)).toBeUndefined();
	});

	test("emits an empty new epoch and clears retained entries when the child transcript resets", async () => {
		const results = [
			transcriptResult(
				0,
				50,
				transcriptEntries({
					type: "message",
					id: "before-reset",
					parentId: null,
					timestamp: "2026-07-15T00:00:00.000Z",
					message: { role: "user", content: "before reset" },
				}),
			),
			transcriptResult(50, 50),
		];
		const reads: number[] = [];
		const emitted: AgentTranscriptFrame[] = [];
		const projection = new AgentTranscriptProjection({
			hostId: host,
			sessionId: session,
			epoch: "parent-epoch",
			read: async (_agent, fromByte) => {
				reads.push(fromByte);
				return results.shift() ?? transcriptResult(fromByte, fromByte);
			},
			revision: () => currentRevision,
			emit: frame => emitted.push(frame),
		});

		projection.refresh("WorkerA");
		await waitUntil(() => emitted.length === 1 && reads.length === 2);
		const firstEpoch = emitted[0]?.cursor.epoch;
		expect(projection.frames()[0]?.entries).toHaveLength(1);

		results.push(transcriptResult(0, 0, [], true));
		projection.refresh("WorkerA");
		await waitUntil(() => emitted.length === 2);

		expect(reads).toEqual([0, 50, 50]);
		expect(emitted[1]).toMatchObject({
			type: "agent.transcript",
			agentId: "WorkerA",
			cursor: { seq: 1 },
			entries: [],
		});
		expect(emitted[1]?.cursor.epoch).not.toBe(firstEpoch);
		expect(projection.frames()).toEqual([emitted[1]]);
	});

	test("degrades an individually oversized projected tool entry instead of advancing past it", async () => {
		const longA = "a".repeat(65_536);
		const longB = "b".repeat(65_500);
		const results = [
			transcriptResult(
				0,
				100,
				transcriptEntries(
					{
						type: "message",
						id: "large-call",
						parentId: null,
						timestamp: "2026-07-15T00:00:00.000Z",
						message: {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "large-tool",
									name: "edit",
									arguments: { first: longA, second: longB },
								},
							],
						},
					},
					{
						type: "message",
						id: "large-result",
						parentId: "large-call",
						timestamp: "2026-07-15T00:00:01.000Z",
						message: {
							role: "toolResult",
							toolCallId: "large-tool",
							content: [{ type: "text", text: "x".repeat(65_536) }],
							details: { first: longA, second: longB },
							isError: false,
						},
					},
				),
			),
			transcriptResult(100, 100),
		];
		const emitted: AgentTranscriptFrame[] = [];
		const projection = new AgentTranscriptProjection({
			hostId: host,
			sessionId: session,
			epoch: "parent-epoch",
			read: async (_agent, fromByte) => results.shift() ?? transcriptResult(fromByte, fromByte),
			revision: () => currentRevision,
			emit: frame => emitted.push(frame),
		});

		projection.refresh("WorkerA");
		await waitUntil(() => emitted.length === 1);

		expect(emitted[0]?.entries).toHaveLength(1);
		expect(entriesBytes(emitted[0]?.entries ?? [])).toBeLessThanOrEqual(384 * 1_024);
		expect(encoder.encode(JSON.stringify(emitted[0])).byteLength).toBeLessThan(1_024 * 1_024);
		expect(emitted[0]?.entries[0]?.data).toMatchObject({
			tool: "edit",
			args: { first: longA, second: longB },
			result: {
				details: { omitted: "Field exceeded the agent transcript display budget." },
				isError: false,
			},
		});
		expect(() => decodeServerFrame(emitted[0])).not.toThrow();
	});

	test("coalesces refreshes while bounding emitted and retained transcript entries", async () => {
		const firstRead = Promise.withResolvers<RpcSubagentMessagesResult>();
		const reads: number[] = [];
		const emitted: AgentTranscriptFrame[] = [];
		const imageSha = "f".repeat(64);
		const embeddedImage = `iVBORw0KGgo${"B".repeat(8_192)}`;
		const entries = Array.from({ length: 650 }, (_, index) => ({
			type: "message",
			id: `message-${index}`,
			parentId: null,
			timestamp: "2026-07-15T00:00:00.000Z",
			message: {
				role: "assistant",
				content:
					index === 0
						? [
								{ type: "text", text: `private /home/tester/private/${"x".repeat(1_024)}` },
								{ type: "image", mimeType: "image/png", data: embeddedImage, appImageSha256: imageSha },
							]
						: [{ type: "text", text: `${index}:${"x".repeat(1_024)}` }],
			},
		})) as unknown as RpcSubagentMessagesResult["entries"];
		const projection = new AgentTranscriptProjection({
			hostId: host,
			sessionId: session,
			epoch: "parent-epoch",
			read: async (_agent, fromByte) => {
				reads.push(fromByte);
				return fromByte === 0 ? firstRead.promise : transcriptResult(fromByte, fromByte);
			},
			revision: () => currentRevision,
			emit: frame => emitted.push(frame),
		});

		projection.refresh("WorkerA");
		projection.refresh("WorkerA");
		projection.refresh("WorkerA");
		await waitUntil(() => reads.length === 1);
		expect(reads).toEqual([0]);

		firstRead.resolve(transcriptResult(0, 1, entries));
		await waitUntil(() => reads.length === 2 && emitted.length > 1);

		expect(reads).toEqual([0, 1]);
		for (const frame of emitted) {
			expect(frame.entries.length).toBeLessThanOrEqual(512);
			expect(entriesBytes(frame.entries)).toBeLessThanOrEqual(384 * 1_024);
			expect(encoder.encode(JSON.stringify(frame)).byteLength).toBeLessThan(1_024 * 1_024);
			expect(() => decodeServerFrame(frame)).not.toThrow();
		}
		const [baseline] = projection.frames();
		expect(baseline).toBeDefined();
		expect(baseline?.entries.length).toBeLessThanOrEqual(512);
		expect(entriesBytes(baseline?.entries ?? [])).toBeLessThanOrEqual(384 * 1_024);
		expect(baseline?.cursor).toEqual(emitted.at(-1)!.cursor);
		const serialized = JSON.stringify([...emitted, baseline]);
		expect(serialized).not.toContain(embeddedImage);
		expect(serialized).not.toContain("/home/tester");
		expect(projection.transcriptImage(entryId("message-0"), imageSha)).toEqual({
			sha256: imageSha,
			mimeType: "image/png",
		});
	});

	test("bounds retained agent transcripts with least-recently-used eviction", async () => {
		const emitted: AgentTranscriptFrame[] = [];
		const projection = new AgentTranscriptProjection({
			hostId: host,
			sessionId: session,
			epoch: "parent-epoch",
			read: async (agent, fromByte) =>
				fromByte === 0
					? transcriptResult(
							0,
							1,
							transcriptEntries({
								type: "message",
								id: `${agent}-message`,
								parentId: null,
								timestamp: "2026-07-15T00:00:00.000Z",
								message: { role: "assistant", content: [{ type: "text", text: agent }] },
							}),
						)
					: transcriptResult(fromByte, fromByte),
			revision: () => currentRevision,
			emit: frame => emitted.push(frame),
		});

		for (let index = 0; index < 257; index++) projection.refresh(`Worker${index}`);
		await waitUntil(() => projection.frames().length === 256);

		expect(projection.frames()).toHaveLength(256);
		expect(projection.frames().some(frame => frame.agentId === "Worker0")).toBe(false);
		expect(projection.frames().some(frame => frame.agentId === "Worker256")).toBe(true);

		projection.refresh("Worker0");
		await waitUntil(() => projection.frames().some(frame => frame.agentId === "Worker0"));
		expect(projection.frames()).toHaveLength(256);
		expect(projection.frames().some(frame => frame.agentId === "Worker1")).toBe(false);
	});
});
