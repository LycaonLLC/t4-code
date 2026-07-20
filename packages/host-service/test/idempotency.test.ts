import { describe, expect, test } from "bun:test";
import type { CommandId } from "@t4-code/host-wire";
import { IdempotencyStore } from "../src/idempotency.ts";
import type { CommandOutcome } from "../src/types.ts";

function commandId(value: string): CommandId {
	return value as CommandId;
}

function outcome(value: string): CommandOutcome {
	return {
		frame: {
			v: "omp-app/1",
			type: "error",
			code: value,
			message: value,
		} as never,
	};
}

describe("bounded idempotency outcomes", () => {
	test("replays equivalent payloads and rejects conflicts within the five-minute window", () => {
		let now = 10_000;
		const store = new IdempotencyStore({ now: () => now });
		const id = commandId("within-window");
		const payload = { requestId: "first", command: "session.list", args: { a: 1, b: 2 } };
		const completed = outcome("completed");

		expect(store.begin(id, payload).kind).toBe("new");
		store.complete(id, payload, completed);
		now += 5 * 60_000 - 1;

		expect(store.begin(id, { requestId: "retry", args: { b: 2, a: 1 }, command: "session.list" })).toEqual({
			kind: "replay",
			outcome: completed,
		});
		expect(store.begin(id, { ...payload, args: { a: 2, b: 2 } })).toMatchObject({ kind: "conflict" });
	});

	test("ignores transport and confirmation envelope ids, not nested UI response targets", () => {
		const store = new IdempotencyStore();
		const id = commandId("nested-request-id");
		const payload = {
			requestId: "transport-first",
			confirmationId: "confirmation-first",
			command: "session.ui.respond",
			args: { requestId: "ui-request-one", confirmed: true },
		};
		expect(store.begin(id, payload).kind).toBe("new");
		store.complete(id, payload, outcome("completed"));

		expect(
			store.begin(id, {
				...payload,
				requestId: "transport-retry",
				confirmationId: "confirmation-retry",
			}).kind,
		).toBe("replay");
		expect(
			store.begin(id, {
				...payload,
				requestId: "transport-retry",
				args: { requestId: "ui-request-two", confirmed: true },
			}),
		).toMatchObject({ kind: "conflict" });
	});

	test("forgets completed outcomes when the five-minute window expires", () => {
		let now = 20_000;
		const store = new IdempotencyStore({ now: () => now });
		const id = commandId("expired");
		const payload = { command: "host.list", args: {} };

		expect(store.begin(id, payload).kind).toBe("new");
		store.complete(id, payload, outcome("old"));
		now += 5 * 60_000;

		expect(store.begin(id, payload).kind).toBe("new");
	});

	test("evicts the least-recently-used completed outcome at the configured cap", () => {
		const store = new IdempotencyStore({ maxCompletedEntries: 2 });
		const payload = { command: "host.list", args: {} };
		const a = commandId("lru-a");
		const b = commandId("lru-b");
		const c = commandId("lru-c");

		for (const [id, value] of [
			[a, "a"],
			[b, "b"],
		] as const) {
			expect(store.begin(id, payload).kind).toBe("new");
			store.complete(id, payload, outcome(value));
		}
		expect(store.begin(a, payload).kind).toBe("replay");
		expect(store.begin(c, payload).kind).toBe("new");
		store.complete(c, payload, outcome("c"));

		expect(store.begin(a, payload).kind).toBe("replay");
		expect(store.begin(c, payload).kind).toBe("replay");
		expect(store.begin(b, payload).kind).toBe("new");
	});

	test("defaults to at most 1,024 completed outcomes", () => {
		const store = new IdempotencyStore();
		const payload = { command: "host.list", args: {} };
		for (let index = 0; index <= 1024; index += 1) {
			const id = commandId(`default-cap-${index}`);
			expect(store.begin(id, payload).kind).toBe("new");
			store.complete(id, payload, outcome(String(index)));
		}

		expect(store.begin(commandId("default-cap-1"), payload).kind).toBe("replay");
		expect(store.begin(commandId("default-cap-1024"), payload).kind).toBe("replay");
		expect(store.begin(commandId("default-cap-0"), payload).kind).toBe("new");
	});

	test("never evicts pending commands for expiry or completed-outcome pressure", async () => {
		let now = 0;
		const store = new IdempotencyStore({
			now: () => now,
			completedTtlMs: 1_000,
			maxCompletedEntries: 1,
		});
		const payload = { command: "session.prompt", args: { text: "hello" } };
		const pendingId = commandId("pending");
		expect(store.begin(pendingId, payload).kind).toBe("new");

		for (const id of [commandId("pressure-a"), commandId("pressure-b")]) {
			expect(store.begin(id, payload).kind).toBe("new");
			store.complete(id, payload, outcome(String(id)));
		}
		now = 1_000;
		const retry = store.begin(pendingId, payload);
		expect(retry.kind).toBe("pending");
		const completed = outcome("pending-completed");
		store.complete(pendingId, payload, completed);

		expect(await (retry.kind === "pending" ? retry.outcome : Promise.reject(new Error("not pending")))).toBe(
			completed,
		);
		expect(store.begin(pendingId, payload)).toEqual({ kind: "replay", outcome: completed });
	});

	test("settles pending retries as outcome unknown without changing their payload hash", async () => {
		const store = new IdempotencyStore();
		const id = commandId("unknown");
		const payload = { command: "session.prompt", args: { text: "hello" } };
		expect(store.begin(id, payload).kind).toBe("new");
		const retry = store.begin(id, payload);
		expect(retry.kind).toBe("pending");

		store.unknown(id);
		const completed = await (retry.kind === "pending" ? retry.outcome : Promise.reject(new Error("not pending")));
		expect(completed).toMatchObject({ unknown: true, frame: { code: "outcome_unknown" } });
		expect(store.begin(id, payload)).toMatchObject({ kind: "replay", outcome: { unknown: true } });
	});
});
