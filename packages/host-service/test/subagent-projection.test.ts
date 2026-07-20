import { describe, expect, test } from "bun:test";
import { type AgentFrame, hostId, sessionId } from "@t4-code/host-wire";
import { SubagentProjection } from "../src/subagent-projection.ts";

const host = hostId("subagent-host");
const session = sessionId("parent-session");

describe("appserver subagent projection", () => {
	test("projects bounded progress, context usage, and safe evidence", () => {
		const projection = new SubagentProjection(host, session, () => 100);
		expect(
			projection.applyFrame({
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerA",
					index: 2,
					agent: "task",
					description: "Inspect /home/tester/private token=plaintext",
					status: "started",
					lastUpdate: 50,
				},
			}),
		).toMatchObject({
			type: "agent",
			agentId: "WorkerA",
			state: "started",
			detail: {
				description: "Inspect [path] token=[redacted]",
				startedAt: "1970-01-01T00:00:00.050Z",
			},
		});
		const progress = projection.applyFrame({
			type: "subagent_progress",
			payload: {
				index: 2,
				agent: "task",
				task: "Implement projection",
				progress: {
					id: "WorkerA",
					agent: "task",
					status: "running",
					lastIntent: "Editing /Users/name/project/src.ts",
					currentTool: "edit",
					recentOutput: ["Bearer abcdefghijklmnop at /tmp/private.txt"],
					resolvedModel: "openai/gpt-5.6-luna:high",
					contextTokens: 2_000,
					contextWindow: 8_000,
					tokens: 12_000,
					toolCount: 4,
					durationMs: 500,
				},
			},
		});
		expect(progress).toMatchObject({
			type: "agent",
			state: "running",
			detail: {
				title: "Implement projection",
				progress: "Editing [path]",
				evidence: "Bearer [redacted] at [path]",
				currentTool: "edit",
				model: "openai/gpt-5.6-luna:high",
				contextUsage: { used: 2_000, limit: 8_000 },
				tokenVolume: 12_000,
				toolCount: 4,
				durationMs: 500,
			},
		});
		expect(JSON.stringify(progress)).not.toContain("/Users/");
		expect(JSON.stringify(progress)).not.toContain("abcdefghijklmnop");
	});

	test("allows terminal agents to become parked, resumable, and live again", () => {
		const projection = new SubagentProjection(host, session, () => 100);
		projection.applyFrame({
			type: "subagent_lifecycle",
			payload: { id: "WorkerA", index: 0, agent: "task", status: "started" },
		});
		expect(
			projection.applyFrame({
				type: "subagent_lifecycle",
				payload: { id: "WorkerA", index: 0, agent: "task", status: "completed" },
			}),
		).toMatchObject({ state: "completed" });
		expect(
			projection.applyFrame({
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerA",
					index: 0,
					agent: "task",
					status: "parked",
					resumable: true,
				},
			}),
		).toMatchObject({ state: "parked", detail: { resumable: true } });
		const resumed = projection.applyFrame({
			type: "subagent_lifecycle",
			payload: { id: "WorkerA", index: 0, agent: "task", status: "started" },
		});
		expect(resumed).toMatchObject({ state: "started", detail: { resumable: true } });
		expect(
			projection.applyFrame({
				type: "subagent_lifecycle",
				payload: { id: "WorkerA", index: 0, agent: "task", status: "aborted", resumable: true },
			}),
		).toMatchObject({ state: "cancelled", detail: { resumable: false } });
	});

	test("matches the frozen Agent View lifecycle corpus", async () => {
		const corpus = (await Bun.file(
			new URL("../../host-wire/fixtures/v1/scenarios/agent-view-lifecycle.json", import.meta.url),
		).json()) as { frames: AgentFrame[] };
		let now = 1_000;
		const projection = new SubagentProjection(hostId("agent-view-host"), sessionId("agent-view-session"), () => now);
		const at = (milliseconds: number, frame: Record<string, unknown>) => {
			now = milliseconds;
			return projection.applyFrame(frame);
		};
		const frames = [
			projection.applyFrame({
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerA",
					index: 0,
					agent: "task",
					description: "Inspect runtime",
					status: "started",
					lastUpdate: 1_000,
				},
			}),
			at(2_000, {
				type: "subagent_progress",
				payload: {
					index: 0,
					agent: "task",
					task: "Verify parity",
					progress: {
						id: "WorkerA",
						agent: "task",
						status: "running",
						lastIntent: "Checking fixture parity",
						recentOutput: ["Parity frame emitted"],
						currentTool: "read",
						resolvedModel: "openai/gpt-5.6-sol:high",
						contextTokens: 2_000,
						contextWindow: 8_000,
						tokens: 12_000,
						toolCount: 4,
						durationMs: 500,
					},
				},
			}),
			at(3_000, {
				type: "subagent_lifecycle",
				payload: { id: "WorkerA", index: 0, agent: "task", status: "completed", lastUpdate: 3_000 },
			}),
			at(4_000, {
				type: "subagent_lifecycle",
				payload: {
					id: "WorkerA",
					index: 0,
					agent: "task",
					status: "parked",
					lastUpdate: 4_000,
					resumable: true,
				},
			}),
			at(5_000, {
				type: "subagent_lifecycle",
				payload: { id: "WorkerA", index: 0, agent: "task", status: "started", lastUpdate: 5_000 },
			}),
			at(6_000, {
				type: "subagent_lifecycle",
				payload: { id: "WorkerA", index: 0, agent: "task", status: "aborted", lastUpdate: 6_000 },
			}),
		];

		expect(frames).toEqual(corpus.frames);
	});

	test("sorts frames deterministically and survives invalid clock values", () => {
		const projection = new SubagentProjection(host, session, () => Number.POSITIVE_INFINITY);
		for (const [id, index] of [
			["Beta", 1],
			["Alpha", 1],
			["First", 0],
		] as const) {
			projection.applyFrame({
				type: "subagent_lifecycle",
				payload: { id, index, agent: "task", status: "started", lastUpdate: Number.MAX_VALUE },
			});
		}
		expect(projection.frames().map(frame => String(frame.agentId))).toEqual(["First", "Alpha", "Beta"]);
		expect(projection.frames()[0]).toMatchObject({
			detail: {
				startedAt: "1970-01-01T00:00:00.000Z",
				lastActivityAt: "1970-01-01T00:00:00.000Z",
			},
		});
	});
});
