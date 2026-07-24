import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	entryId,
	hostId,
	projectId,
	type ServerFrame,
	sessionId,
	type TranscriptPageArguments,
	type TranscriptPageResult,
} from "@t4-code/host-wire";
import { appserverSupportedFeatures, createAppserver } from "../src/server.ts";
import type { SessionDiscovery, SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("transcript-page-server-test");
const authorityHost = hostId("transcript-page-authority");
const session = sessionId("cold-session");
const stamp = "2026-07-20T00:00:00.000Z";

class PagedDiscovery implements SessionDiscovery {
	loadCalls = 0;
	pageCalls: TranscriptPageArguments[] = [];
	readonly record: SessionRecord = {
		sessionId: session,
		path: "/private/history/cold-session.jsonl",
		cwd: "/tmp/page",
		projectId: projectId("page-project"),
		title: "Cold session",
		updatedAt: stamp,
		status: "idle",
		entriesLoaded: false,
		entries: [],
	};
	async list() {
		return [this.record];
	}
	async load(): Promise<SessionRecord> {
		this.loadCalls += 1;
		throw new Error("whole-file load must not run for transcript.page");
	}
	async page(_record: SessionRecord, args: TranscriptPageArguments): Promise<TranscriptPageResult> {
		this.pageCalls.push(args);
		return {
			entries: [
				{
					id: entryId("tail-entry"),
					parentId: null,
					hostId: authorityHost,
					sessionId: session,
					kind: "message",
					timestamp: stamp,
					data: { role: "assistant", text: "cold tail" },
				},
			],
			hasMore: false,
			generation: "generation-1",
		};
	}
}

async function responseFor(client: RawUdsWebSocket, requestId: string) {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "response" && frame.requestId === requestId) return frame;
	}
}

test("advertises and routes cold transcript pages before whole-file loading", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-transcript-page-server-"));
	const discovery = new PagedDiscovery();
	const socketPath = join(root, "run", "app.sock");
	const appserver = createAppserver({ hostId: host, socketPath, discovery });
	expect(appserverSupportedFeatures({ discovery })).toContain("transcript.page");
	await appserver.start();
	const client = await RawUdsWebSocket.connect(socketPath);
	try {
		client.sendJson({
			v: "omp-app/1",
			type: "hello",
			protocol: { min: "omp-app/1", max: "omp-app/1" },
			client: { name: "page-test", version: "1", build: "test", platform: "linux" },
			requestedFeatures: ["transcript.page"],
			capabilities: { client: ["sessions.read"] },
			savedCursors: [],
		});
		const welcome = await client.nextServer();
		expect(welcome).toMatchObject({ type: "welcome", grantedFeatures: ["transcript.page"] });
		expect((await client.nextServer()).type).toBe("sessions");

		client.sendJson({
			v: "omp-app/1",
			type: "command",
			requestId: "page-1",
			commandId: "page-command",
			hostId: host,
			sessionId: session,
			command: "transcript.page",
			args: { limit: 17, maxBytes: 4096 },
		});
		const response = (await responseFor(client, "page-1")) as Extract<ServerFrame, { type: "response" }>;
		expect(response).toMatchObject({ ok: true, result: { hasMore: false, generation: "generation-1" } });
		expect((response.result as TranscriptPageResult).entries[0]).toMatchObject({ hostId: host, sessionId: session });
		expect(discovery.pageCalls).toEqual([{ limit: 17, maxBytes: 4096 }]);
		expect(discovery.loadCalls).toBe(0);
	} finally {
		client.destroy();
		await client.closed();
		await appserver.stop();
		await rm(root, { recursive: true, force: true });
	}
});
