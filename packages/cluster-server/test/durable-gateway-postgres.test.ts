import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
interface DurableLedgerOptions {
	readonly url: string;
	readonly cursorSecret: string;
	readonly eventRetention: number;
}
interface PostgresLedgerLike {
	migrate(): Promise<void>;
	close(): Promise<void>;
}
interface ApiPrincipal {
	readonly id: string;
	readonly scopes: ReadonlySet<string>;
}
interface PrincipalAuthenticator {
	authenticate(token: string): Promise<ApiPrincipal | undefined>;
}
interface T4PublicApiV1Like {
	handle(request: Request): Promise<Response>;
}
interface OutboxMutation {
	readonly idempotencyToken: string;
	readonly targetId: string;
	readonly kind: string;
}
interface KubernetesOutboxApplier {
	apply(mutation: OutboxMutation, fence: { ownerId: string; epoch: bigint }): Promise<void>;
}
interface OutboxClaim {
	readonly outboxId: bigint;
}
interface DurableOutboxWorkerLike {
	acquireLease(): Promise<{ ownerId: string; epoch: bigint }>;
	drain(): Promise<number>;
	claimNext(): Promise<OutboxClaim | undefined>;
	applyClaim(claim: OutboxClaim): Promise<string>;
}
type LedgerConstructor = new (options: DurableLedgerOptions) => PostgresLedgerLike;
type ApiConstructor = new (options: { ledger: PostgresLedgerLike; authenticator: PrincipalAuthenticator }) => T4PublicApiV1Like;
type WorkerConstructor = new (options: { ledger: PostgresLedgerLike; ownerId: string; applier: KubernetesOutboxApplier }) => DurableOutboxWorkerLike;

const DATABASE_URL = process.env.T4_TEST_POSTGRES_URL;
const VERSION = "1";
const OWNER_TOKEN = "opaque-owner-token-with-sufficient-entropy";
const OTHER_TOKEN = "opaque-other-token-with-sufficient-entropy";
const ALL_SCOPES = new Set([
	"discovery.read",
	"workspaces.read",
	"workspaces.write",
	"sessions.read",
	"sessions.write",
	"commands.write",
	"events.read",
]);
const CURSOR_SECRET = "test-cursor-secret-that-is-at-least-thirty-two-bytes";
const LEDGER_MODULE_PATH = "../src/ledger.ts";
const API_MODULE_PATH = "../src/public-api-v1.ts";
const WORKER_MODULE_PATH = "../src/outbox-worker.ts";

let PostgresLedger: LedgerConstructor | undefined;
let T4PublicApiV1: ApiConstructor | undefined;
let DurableOutboxWorker: WorkerConstructor | undefined;

class TestAuthenticator implements PrincipalAuthenticator {
	readonly #principals: Record<string, ApiPrincipal> = {
		[OWNER_TOKEN]: { id: "owner@example.com", scopes: ALL_SCOPES },
		[OTHER_TOKEN]: { id: "other@example.com", scopes: ALL_SCOPES },
	};
	async authenticate(token: string): Promise<ApiPrincipal | undefined> {
		return this.#principals[token];
	}
}

class ObservableKubernetes implements KubernetesOutboxApplier {
	readonly attempts: OutboxMutation[] = [];
	readonly applied = new Map<string, OutboxMutation>();
	currentEpoch = 0n;
	async apply(mutation: OutboxMutation, fence: { ownerId: string; epoch: bigint }): Promise<void> {
		this.attempts.push(mutation);
		if (fence.epoch !== this.currentEpoch) throw new Error("stale owner epoch");
		this.applied.set(mutation.idempotencyToken, mutation);
	}
}

function ledgerOptions(overrides: Partial<DurableLedgerOptions> = {}): DurableLedgerOptions {
	if (!DATABASE_URL) throw new Error("T4_TEST_POSTGRES_URL is required for durable gateway tests");
	return {
		url: DATABASE_URL,
		cursorSecret: CURSOR_SECRET,
		eventRetention: 3,
		...overrides,
	};
}

async function newLedger(overrides: Partial<DurableLedgerOptions> = {}): Promise<PostgresLedgerLike> {
	if (!PostgresLedger) throw new Error("PostgreSQL ledger implementation is unavailable");
	const ledger = new PostgresLedger(ledgerOptions(overrides));
	await ledger.migrate();
	return ledger;
}

function newApi(ledger: PostgresLedgerLike): T4PublicApiV1Like {
	if (!T4PublicApiV1) throw new Error("public T4 API v1 implementation is unavailable");
	return new T4PublicApiV1({ ledger, authenticator: new TestAuthenticator() });
}

function newWorker(ledger: PostgresLedgerLike, ownerId: string, applier: KubernetesOutboxApplier): DurableOutboxWorkerLike {
	if (!DurableOutboxWorker) throw new Error("durable outbox worker implementation is unavailable");
	return new DurableOutboxWorker({ ledger, ownerId, applier });
}

function headers(token = OWNER_TOKEN, additions: Record<string, string> = {}): Headers {
	return new Headers({
		authorization: `Bearer ${token}`,
		"t4-api-version": VERSION,
		...additions,
	});
}

async function call(
	api: T4PublicApiV1Like,
	method: string,
	path: string,
	options: { token?: string; key?: string; ifMatch?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	const requestHeaders = headers(options.token, options.headers);
	if (options.key) requestHeaders.set("idempotency-key", options.key);
	if (options.ifMatch) requestHeaders.set("if-match", options.ifMatch);
	let body: string | undefined;
	if (options.rawBody !== undefined) body = options.rawBody;
	else if (options.body !== undefined) body = JSON.stringify(options.body);
	if (body !== undefined) requestHeaders.set("content-type", "application/json");
	return await api.handle(new Request(`https://t4.example.test${path}`, { method, headers: requestHeaders, body }));
}

interface JsonDocument extends Record<string, unknown> {
	id: string;
	cursor: string;
	state: string;
	revision: number;
	error: { code: string; message: string; [key: string]: unknown };
}

async function json(response: Response): Promise<JsonDocument> {
	return await response.json() as JsonDocument;
}

function eventData(responseBody: string): JsonDocument[] {
	return responseBody
		.split("\n\n")
		.flatMap(frame => frame.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as JsonDocument));
}

let admin: SQL;

beforeAll(async () => {
	if (!DATABASE_URL) throw new Error("T4_TEST_POSTGRES_URL is required for durable gateway tests");
	admin = new SQL(DATABASE_URL, { max: 1, bigint: true });
	await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
	const modules = await Promise.all([
		import(/* @vite-ignore */ LEDGER_MODULE_PATH).catch(() => undefined),
		import(/* @vite-ignore */ API_MODULE_PATH).catch(() => undefined),
		import(/* @vite-ignore */ WORKER_MODULE_PATH).catch(() => undefined),
	]);
	PostgresLedger = (modules[0] as { PostgresLedger?: LedgerConstructor } | undefined)?.PostgresLedger;
	T4PublicApiV1 = (modules[1] as { T4PublicApiV1?: ApiConstructor } | undefined)?.T4PublicApiV1;
	DurableOutboxWorker = (modules[2] as { DurableOutboxWorker?: WorkerConstructor } | undefined)?.DurableOutboxWorker;
});

afterAll(async () => {
	await admin?.close();
});

describe.sequential("PostgreSQL-backed public T4 API v1", () => {
	it("replays an identical create after process restart without a second Kubernetes mutation", async () => {
		expect(PostgresLedger, "PostgreSQL ledger implementation is required").toBeDefined();
		expect(T4PublicApiV1, "public T4 API v1 implementation is required").toBeDefined();
		expect(DurableOutboxWorker, "durable outbox worker implementation is required").toBeDefined();
		let ledger = await newLedger();
		let api = newApi(ledger);
		const key = "restart-workspace-key-0001";
		const accepted = await call(api, "POST", "/v1/workspaces", { key, body: { name: "durable workspace", labels: { team: "runtime" } } });
		expect(accepted.status).toBe(202);
		expect(accepted.headers.get("idempotency-replayed")).toBe("false");
		const acceptedBody = await json(accepted);

		const kubernetes = new ObservableKubernetes();
		const firstWorker = newWorker(ledger, "worker-a", kubernetes);
		const firstLease = await firstWorker.acquireLease();
		kubernetes.currentEpoch = firstLease.epoch;
		expect(await firstWorker.drain()).toBeGreaterThan(0);
		expect(kubernetes.applied.size).toBe(1);
		await ledger.close();

		ledger = await newLedger();
		api = newApi(ledger);
		const replay = await call(api, "POST", "/v1/workspaces", { key, body: { labels: { team: "runtime" }, name: "durable workspace" } });
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotency-replayed")).toBe("true");
		expect(await json(replay)).toEqual(acceptedBody);
		const secondWorker = newWorker(ledger, "worker-b", kubernetes);
		const secondLease = await secondWorker.acquireLease();
		kubernetes.currentEpoch = secondLease.epoch;
		expect(await secondWorker.drain()).toBe(0);
		expect(kubernetes.applied.size).toBe(1);
		await ledger.close();
	});

	it("uses validated JCS identity, reports conflicts, and scopes keys by principal", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const key = "principal-jcs-key-0000001";
		const first = await call(api, "POST", "/v1/workspaces", { key, body: { name: "one", labels: { b: "2", a: "1" } } });
		expect(first.status).toBe(202);
		const same = await call(api, "POST", "/v1/workspaces", { key, body: { labels: { a: "1", b: "2" }, name: "one" } });
		expect(same.status).toBe(200);
		expect(same.headers.get("idempotency-replayed")).toBe("true");
		const conflict = await call(api, "POST", "/v1/workspaces", { key, body: { name: "two", labels: { a: "1", b: "2" } } });
		expect(conflict.status).toBe(409);
		expect((await json(conflict)).error.code).toBe("idempotency_conflict");
		const isolated = await call(api, "POST", "/v1/workspaces", { token: OTHER_TOKEN, key, body: { name: "other" } });
		expect(isolated.status).toBe(202);
		await ledger.close();
	});

	it("recovers a commit-before-CR crash through one idempotent fenced application", async () => {
		let ledger = await newLedger();
		let api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", {
			key: "crash-parent-workspace-001",
			body: { name: "crash parent" },
		}));
		const sessionResponse = await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, {
			key: "commit-before-crash-0001",
			body: { title: "recover me" },
		});
		expect(sessionResponse.status).toBe(202);
		const session = await json(sessionResponse);
		await ledger.close();

		ledger = await newLedger();
		api = newApi(ledger);
		const kubernetes = new ObservableKubernetes();
		const worker = newWorker(ledger, "recovery-worker", kubernetes);
		const lease = await worker.acquireLease();
		kubernetes.currentEpoch = lease.epoch;
		expect(await worker.drain()).toBeGreaterThan(0);
		expect([...kubernetes.applied.values()].filter(value => value.targetId === session.id)).toHaveLength(1);
		const replay = await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, {
			key: "commit-before-crash-0001",
			body: { title: "recover me" },
		});
		expect(replay.status).toBe(200);
		expect(await json(replay)).toEqual(session);
		await ledger.close();
	});

	it("fences a stale owner from applying, acknowledging, or publishing events", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "fence-workspace-key-001", body: { name: "fence" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "fence-session-key-0001", body: { title: "fenced" } }));
		const kubernetes = new ObservableKubernetes();
		const stale = newWorker(ledger, "stale", kubernetes);
		const staleLease = await stale.acquireLease();
		kubernetes.currentEpoch = staleLease.epoch;
		const claim = await stale.claimNext();
		expect(claim).toBeDefined();

		const current = newWorker(ledger, "current", kubernetes);
		const currentLease = await current.acquireLease();
		kubernetes.currentEpoch = currentLease.epoch;
		expect(await stale.applyClaim(claim as OutboxClaim)).toBe("fenced");
		expect(kubernetes.attempts).toHaveLength(0);
		expect(await current.drain()).toBeGreaterThan(0);
		const events = await admin`SELECT owner_epoch FROM t4_events WHERE session_id = ${session.id} ORDER BY sequence` as { owner_epoch: bigint }[];
		expect(events.every(row => row.owner_epoch === currentLease.epoch || row.owner_epoch === 0n)).toBe(true);
		await ledger.close();
	});

	it("resumes SSE strictly after a durable cursor and returns typed 410 after retention expiry", async () => {
		const ledger = await newLedger({ eventRetention: 3 });
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "sse-workspace-key-00001", body: { name: "sse" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "sse-session-key-000001", body: { title: "events" } }));
		const snapshot = await json(await call(api, "GET", `/v1/sessions/${session.id}/snapshot`));
		for (let index = 0; index < 2; index++) {
			const response = await call(api, "POST", `/v1/sessions/${session.id}/commands`, {
				key: `sse-command-key-00000${index}`,
				body: { command: `echo ${index}` },
			});
			expect(response.status).toBe(202);
		}
		const first = await call(api, "GET", `/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(snapshot.cursor)}&maxEvents=1&heartbeatSeconds=5`);
		expect(first.status).toBe(200);
		const firstEvents = eventData(await first.text());
		expect(firstEvents).toHaveLength(1);
		const deliveredCursor = firstEvents[0].cursor as string;
		const second = await call(api, "GET", `/v1/sessions/${session.id}/events?maxEvents=100&heartbeatSeconds=5`, {
			headers: { "last-event-id": deliveredCursor },
		});
		expect(second.status).toBe(200);
		const secondEvents = eventData(await second.text());
		expect(secondEvents.map(value => value.cursor)).not.toContain(deliveredCursor);
		expect(new Set([...firstEvents, ...secondEvents].map(value => value.cursor)).size).toBe(firstEvents.length + secondEvents.length);

		for (let index = 2; index < 7; index++) {
			await call(api, "POST", `/v1/sessions/${session.id}/commands`, {
				key: `sse-command-key-00000${index}`,
				body: { command: `echo ${index}` },
			});
		}
		const expired = await call(api, "GET", `/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(deliveredCursor)}&maxEvents=1&heartbeatSeconds=5`);
		expect(expired.status).toBe(410);
		const expiredBody = await json(expired);
		expect(expiredBody.error).toMatchObject({
			code: "cursor_expired",
			resync: { snapshotUrl: `/v1/sessions/${session.id}/snapshot` },
		});
		await ledger.close();
	});

	it("persists cancellation before dispatch and keeps lifecycle monotonic across restart", async () => {
		let ledger = await newLedger();
		let api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "cancel-workspace-key-001", body: { name: "cancel" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "cancel-session-key-0001", body: { title: "cancel me" } }));
		const cancellation = await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "cancel-race-key-0000001" });
		expect(cancellation.status).toBe(202);
		expect(await json(cancellation)).toMatchObject({ id: session.id, state: "cancelling", revision: 2 });
		await ledger.close();

		ledger = await newLedger();
		api = newApi(ledger);
		const persisted = await call(api, "GET", `/v1/sessions/${session.id}`);
		expect(await json(persisted)).toMatchObject({ id: session.id, state: "cancelling", revision: 2 });
		const kubernetes = new ObservableKubernetes();
		const worker = newWorker(ledger, "cancel-worker", kubernetes);
		const lease = await worker.acquireLease();
		kubernetes.currentEpoch = lease.epoch;
		await worker.drain();
		const appliedForSession = [...kubernetes.applied.values()].filter(value => value.targetId === session.id);
		expect(appliedForSession.map(value => value.kind)).toEqual(["session.cancel"]);
		await ledger.close();
	});

	it("preserves snapshots, status, ordered events, and replay responses on restart", async () => {
		let ledger = await newLedger();
		let api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "durable-status-workspace", body: { name: "status" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "durable-status-session-01", body: { title: "status" } }));
		const command = await json(await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: "durable-status-command-01", body: { command: "printf durable" } }));
		const before = await json(await call(api, "GET", `/v1/sessions/${session.id}/snapshot`));
		await ledger.close();

		ledger = await newLedger();
		api = newApi(ledger);
		expect(await json(await call(api, "GET", `/v1/sessions/${session.id}`))).toEqual(session);
		expect(await json(await call(api, "GET", `/v1/sessions/${session.id}/snapshot`))).toEqual(before);
		const replay = await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: "durable-status-command-01", body: { command: "printf durable" } });
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotency-replayed")).toBe("true");
		expect(await json(replay)).toEqual(command);
		await ledger.close();
	});

	it("rolls back command, intent, event, and outbox together on transaction failure", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		await admin.unsafe(`
			CREATE OR REPLACE FUNCTION t4_test_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.idempotency_key = 'rollback-key-000000001' THEN RAISE EXCEPTION 'injected rollback'; END IF;
				RETURN NEW;
			END $$;
			DROP TRIGGER IF EXISTS t4_test_reject_outbox_trigger ON t4_outbox;
			CREATE TRIGGER t4_test_reject_outbox_trigger BEFORE INSERT ON t4_outbox
			FOR EACH ROW EXECUTE FUNCTION t4_test_reject_outbox();
		`);
		const response = await call(api, "POST", "/v1/workspaces", { key: "rollback-key-000000001", body: { name: "must not persist" } });
		expect(response.status).toBe(503);
		const rows = await admin.unsafe(`
			SELECT
				(SELECT count(*) FROM t4_commands WHERE idempotency_key = 'rollback-key-000000001') AS commands,
				(SELECT count(*) FROM t4_workspace_intents WHERE name = 'must not persist') AS intents,
				(SELECT count(*) FROM t4_outbox WHERE idempotency_key = 'rollback-key-000000001') AS outbox
		`);
		expect(rows[0]).toMatchObject({ commands: 0n, intents: 0n, outbox: 0n });
		await admin.unsafe("DROP TRIGGER t4_test_reject_outbox_trigger ON t4_outbox; DROP FUNCTION t4_test_reject_outbox()");
		await ledger.close();
	});

	it("rejects malformed, oversized, unsupported-version input before ledger or cluster mutation", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const before = await admin`SELECT count(*)::text AS count FROM t4_commands`;
		const malformed = await call(api, "POST", "/v1/workspaces", { key: "malformed-input-key-001", rawBody: "{" });
		expect(malformed.status).toBe(400);
		const oversized = await call(api, "POST", "/v1/workspaces", { key: "oversized-input-key-001", body: { name: "x".repeat(129) } });
		expect(oversized.status).toBe(422);
		const unsupported = await call(api, "POST", "/v1/workspaces", {
			key: "unsupported-version-key",
			body: { name: "unsupported" },
			headers: { "t4-api-version": "2" },
		});
		expect(unsupported.status).toBe(406);
		expect((await json(unsupported)).error).toMatchObject({ code: "incompatible_version", supportedMajors: [1] });
		const after = await admin`SELECT count(*)::text AS count FROM t4_commands`;
		expect(after[0].count).toBe(before[0].count);
		await ledger.close();
	});

	it("returns indistinguishable scoped 404s without accepting a user-provided principal", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "auth-isolation-key-0001", body: { name: "private" } }));
		const outside = await call(api, "GET", `/v1/workspaces/${workspace.id}`, { token: OTHER_TOKEN, headers: { "x-t4-principal": "owner@example.com" } });
		const absent = await call(api, "GET", "/v1/workspaces/absent-resource", { token: OTHER_TOKEN });
		expect(outside.status).toBe(404);
		expect(absent.status).toBe(404);
		const outsideBody = await json(outside);
		const absentBody = await json(absent);
		expect(outsideBody.error.code).toBe("not_found");
		expect(outsideBody.error.message).toBe(absentBody.error.message);
		expect(Object.keys(outsideBody.error).sort()).toEqual(Object.keys(absentBody.error).sort());
		const unauthenticated = await api.handle(new Request("https://t4.example.test/v1", { headers: { "t4-api-version": "1" } }));
		expect(unauthenticated.status).toBe(401);
		await ledger.close();
	});
});
