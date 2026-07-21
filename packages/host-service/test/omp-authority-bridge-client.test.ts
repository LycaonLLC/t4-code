import { describe, expect, test } from "bun:test";
import { hostId, sessionId } from "@t4-code/host-wire";
import { OmpAuthorityBridgeClient, type OmpAuthorityBridgeChild } from "../src/omp-authority-bridge-client.ts";
import type { SessionRecord } from "../src/types.ts";
import {
	decodeOmpAuthorityBridgeClientFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type OmpAuthorityBridgeMethod,
} from "../src/omp-authority-bridge-contract.ts";

class AsyncQueue implements AsyncIterable<string> {
	readonly #values: string[] = [];
	readonly #waiters: Array<(value: IteratorResult<string>) => void> = [];
	#closed = false;
	push(value: string): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}
	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: () => {
				const value = this.#values.shift();
				if (value !== undefined) return Promise.resolve({ done: false, value });
				if (this.#closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.#waiters.push(resolve));
			},
		};
	}
}

class FakeBridgeChild implements OmpAuthorityBridgeChild {
	readonly output = new AsyncQueue();
	readonly error = new AsyncQueue();
	readonly writes: string[] = [];
	readonly exit = Promise.withResolvers<number>();
	killed = false;
	readonly stdin = {
		write: (data: string): void => { this.writes.push(data); },
		end: (): void => { this.output.close(); this.exit.resolve(0); },
	};
	readonly stdout = this.output;
	readonly stderr = this.error;
	readonly exited = this.exit.promise;
	kill(): void { this.killed = true; this.output.close(); this.exit.resolve(143); }
	server(frame: Parameters<typeof encodeOmpAuthorityBridgeFrame>[0]): void {
		this.output.push(encodeOmpAuthorityBridgeFrame(frame));
	}
	request(index = 0) {
		return decodeOmpAuthorityBridgeClientFrame(JSON.parse(this.writes[index]!));
	}
}

const ready = {
	v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type: "ready" as const,
	methods: ["host.info", "session.list", "operation.termOpen", "terminal.input", "terminal.resize", "terminal.close", "lock.status", "usage.read"] as const,
	ompVersion: "17.0.5",
	ompBuild: "bridge-test",
};

describe("OMP authority bridge client", () => {
	test("waits for ready, exposes only advertised authorities, and routes responses", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		expect((await started).methods).toEqual(ready.methods);
		expect(client.identity).toEqual({ ompVersion: "17.0.5", ompBuild: "bridge-test" });
		const authorities = client.createAuthorities();
		expect(authorities.operationsAuthority.filesRead).toBeUndefined();
		expect(typeof authorities.operationsAuthority.termOpen).toBe("function");
		const listed = authorities.sessionAuthority.list();
		await Bun.sleep(0);
		const request = child.request();
		expect(request).toMatchObject({ type: "request", method: "session.list", params: {} });
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: request.id, ok: true, result: [] });
		expect(await listed).toEqual([]);
		await client.stop();
	});

	test("keeps terminal events attached before and after term.open settles", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const authorities = client.createAuthorities();
		const events: unknown[] = [];
		const context = {
			hostId: hostId("host-test"),
			sessionId: sessionId("session-test"),
			deviceId: "device-test",
			connectionId: "connection-test",
			capabilities: new Set(["term.open", "term.input", "term.resize"] as const),
			abortSignal: new AbortController().signal,
			emitTerminalOutput: (frame: unknown) => events.push(frame),
		};
		const opened = authorities.operationsAuthority.termOpen!({}, context);
		await Bun.sleep(0);
		const request = child.request();
		const output = { type: "terminal.output", terminalId: "terminal-1", data: "before" };
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "event", id: request.id, event: "terminal", payload: output });
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: request.id,
			ok: true,
			result: { terminalId: "terminal-1" },
		});
		expect(await opened).toEqual({ terminalId: "terminal-1" });
		const after = { type: "terminal.exit", terminalId: "terminal-1", exitCode: 0 };
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "event", id: request.id, event: "terminal", payload: after });
		await Bun.sleep(0);
		expect(events).toEqual([output, after]);
		await client.stop();
	});

	test("forwards abort and rejects locally without waiting for an unresponsive bridge", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const controller = new AbortController();
		const pending = client.createAuthorities().usageAuthority!.read(controller.signal);
		await Bun.sleep(0);
		const request = child.request();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "ABORTED", message: "operation was cancelled" });
		expect(child.request(1)).toEqual({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "cancel", id: request.id });
		await client.stop();
	});

	test("fails closed on an oversized unfinished bridge frame", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.output.push("x".repeat(OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES + 1));
		await expect(started).rejects.toThrow("bridge output exceeds the line limit");
		expect(child.killed).toBe(true);
	});

	test("strips the loaded transcript from session references sent to the bridge", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		const methods = [...ready.methods, "discovery.page"] as OmpAuthorityBridgeMethod[];
		child.server({ ...ready, methods });
		await started;
		// A record whose 400 KiB transcript would overflow the peer's request-param budget and crash it.
		const loaded = {
			sessionId: sessionId("s"),
			path: "/tmp/s.jsonl",
			cwd: "/tmp",
			projectId: "project-1",
			title: "big",
			updatedAt: "2026-01-01T00:00:00.000Z",
			status: "idle",
			entriesLoaded: true,
			entries: [{ id: "e1", role: "assistant", text: "y".repeat(400 * 1024) }],
		} as unknown as SessionRecord;
		const paging = client.createAuthorities().discovery.page!(loaded, { limit: 10 });
		await Bun.sleep(0);
		const request = child.request();
		expect(request).toMatchObject({
			type: "request",
			method: "discovery.page",
			params: { session: { sessionId: "s", entries: [] }, args: { limit: 10 } },
		});
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: request.id, ok: true, result: { entries: [] } });
		await paging;
		await client.stop();
	});
});
