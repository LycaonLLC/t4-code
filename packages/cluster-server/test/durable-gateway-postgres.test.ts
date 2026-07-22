import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
interface DurableLedgerOptions {
	readonly url: string;
	readonly cursorSecret: string;
	readonly eventRetention: number;
}
interface PostgresLedgerLike {
	migrate(): Promise<void>;
	close(): Promise<void>;
	acquireLease(ownerId: string, leaseSeconds?: number): Promise<{ ownerId: string; epoch: bigint }>;
	claimNext(lease: { ownerId: string; epoch: bigint }): Promise<OutboxClaim | undefined>;
	claimIsCurrent(claim: OutboxClaim): Promise<boolean>;
	acknowledge(claim: OutboxClaim): Promise<boolean>;
	recordFailure(claim: OutboxClaim, message: string): Promise<boolean>;
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
	readonly payload: Readonly<Record<string, unknown>>;
}
interface KubernetesOutboxApplier {
	apply(mutation: OutboxMutation, fence: { ownerId: string; epoch: bigint }): Promise<void>;
}
interface OutboxClaim {
	readonly outboxId: bigint;
	readonly commandId: string;
	readonly principalId: string;
	readonly idempotencyKey: string;
	readonly kind: string;
	readonly targetId: string;
	readonly targetRevision: bigint;
	readonly mutation: Readonly<Record<string, unknown>>;
	readonly ownerId: string;
	readonly ownerEpoch: bigint;
	readonly expiresAt: number;
}
interface AuthoritativeKubernetesStatusObservation {
	readonly resourceId: string;
	readonly principalId: string;
	readonly workspaceId?: string;
	readonly uid: string;
	readonly resourceVersion: string;
	readonly generation: bigint;
	readonly observedGeneration: bigint;
	readonly phase: "Pending" | "Ready" | "Running" | "Failed" | "Terminating" | "Unknown";
}
interface AuthoritativeKubernetesStatusIngress {
	ingestKubernetesStatus(
		lease: { ownerId: string; epoch: bigint },
		collection: "t4workspaces" | "t4sessions",
		observation: AuthoritativeKubernetesStatusObservation,
	): Promise<void>;
}
interface DurableOutboxWorkerLike {
	acquireLease(): Promise<{ ownerId: string; epoch: bigint }>;
	drain(): Promise<number>;
	claimNext(): Promise<OutboxClaim | undefined>;
	applyClaim(claim: OutboxClaim): Promise<string>;
}
type LedgerConstructor = new (options: DurableLedgerOptions) => PostgresLedgerLike;
type ApiConstructor = new (options: { ledger: PostgresLedgerLike; authenticator: PrincipalAuthenticator; allowedOrigins?: readonly string[] }) => T4PublicApiV1Like;
type WorkerConstructor = new (options: { ledger: PostgresLedgerLike; ownerId: string; applier: KubernetesOutboxApplier }) => DurableOutboxWorkerLike;

const DATABASE_URL = process.env.T4_TEST_POSTGRES_URL;
const VERSION = "1";
const OWNER_TOKEN = "opaque-owner-token-with-sufficient-entropy";
const MIXED_CASE_OWNER_TOKEN = "Opaque-Owner-Token-With-Mixed-Case-Entropy";
const OTHER_TOKEN = "opaque-other-token-with-sufficient-entropy";
const INVALID_PRINCIPAL_TOKEN = "invalid-principal-token-with-sufficient-entropy";
const STALE_APPLY_DEADLINE_SECONDS = 5;
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
		[MIXED_CASE_OWNER_TOKEN]: { id: "owner@example.com", scopes: ALL_SCOPES },
		[OTHER_TOKEN]: { id: "other@example.com", scopes: ALL_SCOPES },
		[INVALID_PRINCIPAL_TOKEN]: { id: "Not A CRD Owner", scopes: ALL_SCOPES },
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
class PausedCreateKubernetes implements KubernetesOutboxApplier {
	readonly resources = new Set<string>();
	readonly createStarted = Promise.withResolvers<void>();
	readonly releaseCreate = Promise.withResolvers<void>();
	async apply(mutation: OutboxMutation): Promise<void> {
		if (mutation.kind === "session.create") {
			this.createStarted.resolve();
			await this.releaseCreate.promise;
			this.resources.add(mutation.targetId);
			return;
		}
		if (mutation.kind === "workspace.create") this.resources.add(mutation.targetId);
		if (mutation.kind === "session.cancel" || mutation.kind === "session.delete") this.resources.delete(mutation.targetId);
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

function newApi(ledger: PostgresLedgerLike, allowedOrigins?: readonly string[]): T4PublicApiV1Like {
	if (!T4PublicApiV1) throw new Error("public T4 API v1 implementation is unavailable");
	return new T4PublicApiV1({ ledger, authenticator: new TestAuthenticator(), ...(allowedOrigins ? { allowedOrigins } : {}) });
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

async function waitForDatabase(predicate: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for PostgreSQL concurrency fixture");
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
	if (!DATABASE_URL) return;
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

beforeEach(async () => {
	if (!PostgresLedger) return;
	const ledger = new PostgresLedger(ledgerOptions());
	await ledger.migrate();
	await ledger.close();
	await admin.unsafe("TRUNCATE t4_outbox, t4_event_retention, t4_events, t4_snapshot_entries, t4_session_intents, t4_workspace_intents, t4_commands, t4_owner_leases RESTART IDENTITY CASCADE");
});

afterAll(async () => {
	await admin?.close();
});

const postgresSuite = DATABASE_URL ? describe.sequential : describe.skip;
postgresSuite("PostgreSQL-backed public T4 API v1", () => {
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
		const secondWorker = newWorker(ledger, "worker-a", kubernetes);
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

		await admin`UPDATE t4_owner_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_name = 'gateway-outbox'`;
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
		const first = await call(api, "GET", `/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(snapshot.cursor)}&maxEvents=1&heartbeatSeconds=5`, { headers: { accept: "text/event-stream" } });
		expect(first.status).toBe(200);
		const firstEvents = eventData(await first.text());
		expect(firstEvents).toHaveLength(1);
		const deliveredCursor = firstEvents[0].cursor as string;
		const second = await call(api, "GET", `/v1/sessions/${session.id}/events?maxEvents=100&heartbeatSeconds=5`, {
			headers: { "last-event-id": deliveredCursor, accept: "text/event-stream" },
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
		const expired = await call(api, "GET", `/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(deliveredCursor)}&maxEvents=1&heartbeatSeconds=5`, { headers: { accept: "text/event-stream" } });
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

	it("retries the whole serializable mutation after a real PostgreSQL 40001 exactly once", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		await admin.unsafe(`
			DROP SEQUENCE IF EXISTS t4_test_serialization_attempt;
			CREATE SEQUENCE t4_test_serialization_attempt;
			CREATE OR REPLACE FUNCTION t4_test_serialize_once() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.idempotency_key = 'serialization-retry-key-01' AND nextval('t4_test_serialization_attempt') = 1 THEN
					RAISE SQLSTATE '40001' USING MESSAGE = 'forced serialization rollback';
				END IF;
				RETURN NEW;
			END $$;
			DROP TRIGGER IF EXISTS t4_test_serialize_once_trigger ON t4_outbox;
			CREATE TRIGGER t4_test_serialize_once_trigger BEFORE INSERT ON t4_outbox
			FOR EACH ROW EXECUTE FUNCTION t4_test_serialize_once();
		`);
		const response = await call(api, "POST", "/v1/workspaces", {
			key: "serialization-retry-key-01",
			body: { name: "retry exactly once" },
		});
		expect(response.status).toBe(202);

		const accepted = await json(response);
		const rows = await admin.unsafe(`
			SELECT
				(SELECT last_value FROM t4_test_serialization_attempt) AS attempts,
				(SELECT count(*) FROM t4_commands WHERE idempotency_key = 'serialization-retry-key-01') AS commands,
				(SELECT count(*) FROM t4_workspace_intents WHERE workspace_id = '${accepted.id}') AS intents,
				(SELECT count(*) FROM t4_outbox WHERE idempotency_key = 'serialization-retry-key-01') AS outbox
		`);
		expect(rows[0]).toMatchObject({ attempts: 2n, commands: 1n, intents: 1n, outbox: 1n });
		await admin.unsafe("DROP TRIGGER t4_test_serialize_once_trigger ON t4_outbox; DROP FUNCTION t4_test_serialize_once(); DROP SEQUENCE t4_test_serialization_attempt");
		await ledger.close();
	});

	it("retries the whole serializable mutation after a real PostgreSQL 40P01 exactly once", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		await admin.unsafe(`
			DROP SEQUENCE IF EXISTS t4_test_deadlock_attempt;
			CREATE SEQUENCE t4_test_deadlock_attempt;
			CREATE OR REPLACE FUNCTION t4_test_deadlock_once() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.idempotency_key = 'deadlock-retry-key-00001' AND nextval('t4_test_deadlock_attempt') = 1 THEN
					RAISE SQLSTATE '40P01' USING MESSAGE = 'forced deadlock rollback';
				END IF;
				RETURN NEW;
			END $$;
			CREATE TRIGGER t4_test_deadlock_once_trigger BEFORE INSERT ON t4_outbox
			FOR EACH ROW EXECUTE FUNCTION t4_test_deadlock_once();
		`);
		const response = await call(api, "POST", "/v1/workspaces", { key: "deadlock-retry-key-00001", body: { name: "retry deadlock once" } });
		expect(response.status).toBe(202);
		const rows = await admin`SELECT
			(SELECT last_value FROM t4_test_deadlock_attempt) AS attempts,
			(SELECT count(*) FROM t4_commands WHERE idempotency_key = 'deadlock-retry-key-00001') AS commands,
			(SELECT count(*) FROM t4_outbox WHERE idempotency_key = 'deadlock-retry-key-00001') AS outbox` as Array<{ attempts: bigint; commands: bigint; outbox: bigint }>;
		expect(rows[0]).toEqual({ attempts: 2n, commands: 1n, outbox: 1n });
		await admin.unsafe("DROP TRIGGER t4_test_deadlock_once_trigger ON t4_outbox; DROP FUNCTION t4_test_deadlock_once(); DROP SEQUENCE t4_test_deadlock_attempt");
		await ledger.close();
	});

	it("serializes two first-use requests for the same absent idempotency row", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		await admin.unsafe(`
			DROP SEQUENCE IF EXISTS t4_test_absent_key_attempt;
			CREATE SEQUENCE t4_test_absent_key_attempt;
			CREATE OR REPLACE FUNCTION t4_test_pause_first_absent_key() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.idempotency_key = 'absent-idempotency-key-01' THEN
					PERFORM nextval('t4_test_absent_key_attempt');
					IF currval('t4_test_absent_key_attempt') = 1 THEN PERFORM pg_advisory_xact_lock(741406); END IF;
				END IF;
				RETURN NEW;
			END $$;
			DROP TRIGGER IF EXISTS t4_test_pause_absent_key_trigger ON t4_outbox;
			CREATE TRIGGER t4_test_pause_absent_key_trigger BEFORE INSERT ON t4_outbox
			FOR EACH ROW EXECUTE FUNCTION t4_test_pause_first_absent_key();
		`);
		const blocker = new SQL(DATABASE_URL!, { max: 1, bigint: true });
		await blocker`SELECT pg_advisory_lock(741406)`;
		const first = call(api, "POST", "/v1/workspaces", { key: "absent-idempotency-key-01", body: { name: "one durable winner" } });
		let second: Promise<Response> | undefined;
		let responses: Response[] | undefined;
		try {
			await waitForDatabase(async () => (await admin`SELECT is_called FROM t4_test_absent_key_attempt` as Array<{ is_called: boolean }>)[0]?.is_called === true);
			const secondRequest = call(api, "POST", "/v1/workspaces", { key: "absent-idempotency-key-01", body: { name: "one durable winner" } });
			second = secondRequest;
			await waitForDatabase(async () => {
				const blocked = await admin`SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'` as Array<{ count: bigint }>;
				return blocked[0]?.count === 1n;
			});
			await blocker`SELECT pg_advisory_unlock(741406)`;
			responses = await Promise.all([first, secondRequest]);
		} finally {
			await blocker.close();
			await Promise.allSettled([first, ...(second ? [second] : [])]);
			await admin.unsafe("DROP TRIGGER IF EXISTS t4_test_pause_absent_key_trigger ON t4_outbox; DROP FUNCTION IF EXISTS t4_test_pause_first_absent_key(); DROP SEQUENCE IF EXISTS t4_test_absent_key_attempt");
		}
		expect(responses).toBeDefined();
		expect(responses!.map(value => value.status).sort()).toEqual([200, 202]);
		expect(await json(responses![0]!)).toEqual(await json(responses![1]!));
		const rows = await admin`SELECT
			(SELECT count(*) FROM t4_commands WHERE idempotency_key = 'absent-idempotency-key-01') AS commands,
			(SELECT count(*) FROM t4_outbox WHERE idempotency_key = 'absent-idempotency-key-01') AS outbox` as Array<{ commands: bigint; outbox: bigint }>;
		expect(rows[0]).toEqual({ commands: 1n, outbox: 1n });
		await ledger.close();
	});

	it("replays stored patch, create, and command responses before mutable state checks", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "replay-state-workspace-01", body: { name: "original" } }));
		const firstWorkspacePatch = await json(await call(api, "PATCH", `/v1/workspaces/${workspace.id}`, {
			key: "replay-workspace-patch-01", ifMatch: "1", body: { name: "first patch" },
		}));
		expect((await call(api, "PATCH", `/v1/workspaces/${workspace.id}`, {
			key: "replay-workspace-patch-02", ifMatch: "2", body: { name: "second patch" },
		})).status).toBe(200);
		const workspaceReplay = await call(api, "PATCH", `/v1/workspaces/${workspace.id}`, {
			key: "replay-workspace-patch-01", ifMatch: "1", body: { name: "first patch" },
		});
		expect(workspaceReplay.status).toBe(200);
		expect(workspaceReplay.headers.get("idempotency-replayed")).toBe("true");
		expect(await json(workspaceReplay)).toEqual(firstWorkspacePatch);
		const workspaceMismatch = await call(api, "PATCH", `/v1/workspaces/${workspace.id}`, {
			key: "replay-workspace-patch-01", ifMatch: "1", body: { name: "different" },
		});
		expect((await json(workspaceMismatch)).error.code).toBe("idempotency_conflict");

		const sessionKey = "replay-session-create-001";
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: sessionKey, body: { title: "original" } }));
		const firstSessionPatch = await json(await call(api, "PATCH", `/v1/sessions/${session.id}`, {
			key: "replay-session-patch-001", ifMatch: "1", body: { title: "first patch" },
		}));
		expect((await call(api, "PATCH", `/v1/sessions/${session.id}`, {
			key: "replay-session-patch-002", ifMatch: "2", body: { title: "second patch" },
		})).status).toBe(200);
		const commandKey = "replay-command-state-001";
		const command = await json(await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: commandKey, body: { command: "printf original" } }));
		expect((await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "replay-cancel-state-001" })).status).toBe(202);
		const sessionReplay = await call(api, "PATCH", `/v1/sessions/${session.id}`, {
			key: "replay-session-patch-001", ifMatch: "1", body: { title: "first patch" },
		});
		expect(sessionReplay.status).toBe(200);
		expect(await json(sessionReplay)).toEqual(firstSessionPatch);
		const commandReplay = await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: commandKey, body: { command: "printf original" } });
		expect(commandReplay.status).toBe(200);
		expect(await json(commandReplay)).toEqual(command);
		const commandMismatch = await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: commandKey, body: { command: "printf different" } });
		expect((await json(commandMismatch)).error.code).toBe("idempotency_conflict");
		expect((await call(api, "DELETE", `/v1/workspaces/${workspace.id}`, { key: "replay-delete-parent-001" })).status).toBe(204);
		const createReplay = await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: sessionKey, body: { title: "original" } });
		expect(createReplay.status).toBe(200);
		expect(await json(createReplay)).toEqual(session);
		const createMismatch = await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: sessionKey, body: { title: "different" } });
		expect((await json(createMismatch)).error.code).toBe("idempotency_conflict");
		await ledger.close();
	});

	it("keeps cancelling and terminal sessions monotonic across distinct requests", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "monotonic-workspace-key-1", body: { name: "monotonic" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "monotonic-session-key-01", body: { title: "monotonic" } }));
		const firstCancel = await json(await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "monotonic-cancel-key-001" }));
		const repeated = await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "monotonic-cancel-key-002" });
		expect(repeated.status).toBe(202);
		const repeatedReplay = await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "monotonic-cancel-key-002" });
		expect(repeatedReplay.status).toBe(200);
		expect(await json(repeatedReplay)).toEqual(firstCancel);
		expect(await json(repeated)).toEqual(firstCancel);
		expect((await call(api, "PATCH", `/v1/sessions/${session.id}`, { key: "monotonic-patch-key-0001", ifMatch: String(firstCancel.revision), body: { title: "forbidden" } })).status).toBe(404);
		expect((await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: "monotonic-command-key-01", body: { command: "forbidden" } })).status).toBe(404);
		await admin`UPDATE t4_session_intents SET state = 'cancelled' WHERE session_id = ${session.id}`;
		const terminalCancel = await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "monotonic-cancel-key-003" });
		expect(terminalCancel.status).toBe(202);
		const firstDelete = await call(api, "DELETE", `/v1/sessions/${session.id}`, { key: "monotonic-delete-key-001" });
		expect(firstDelete.status).toBe(204);
		expect(firstDelete.headers.get("idempotency-replayed")).toBe("false");
		const deleteReplay = await call(api, "DELETE", `/v1/sessions/${session.id}`, { key: "monotonic-delete-key-001" });
		expect(deleteReplay.status).toBe(204);
		expect(deleteReplay.headers.get("idempotency-replayed")).toBe("true");
		const after = await admin`SELECT
			(SELECT count(*) FROM t4_commands WHERE target_scope = ${`session:${session.id}`}) AS commands,
			(SELECT count(*) FROM t4_outbox WHERE target_id = ${session.id}) AS outbox,
			(SELECT count(*) FROM t4_events WHERE session_id = ${session.id}) AS events,
			(SELECT revision FROM t4_session_intents WHERE session_id = ${session.id}) AS revision` as Array<{ commands: bigint; outbox: bigint; events: bigint; revision: bigint }>;
		expect(after[0]).toEqual({ commands: 4n, outbox: 3n, events: 3n, revision: BigInt(firstCancel.revision) });
		await ledger.close();
	});

	it("renews, excludes, expires, and fences PostgreSQL leases", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const first = await ledger.acquireLease("lease-owner-a", 30);
		const renewed = await ledger.acquireLease("lease-owner-a", 30);
		expect(renewed).toEqual(first);
		await expect(ledger.acquireLease("lease-owner-b", 30)).rejects.toThrow("lease");
		await call(api, "POST", "/v1/workspaces", { key: "lease-fencing-workspace-1", body: { name: "lease" } });
		const claim = await ledger.claimNext(first);
		expect(claim).toBeDefined();
		await admin`UPDATE t4_owner_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_name = 'gateway-outbox'`;
		expect(await ledger.claimIsCurrent(claim!)).toBe(false);
		expect(await ledger.acknowledge(claim!)).toBe(false);
		expect(await ledger.recordFailure(claim!, "expired")).toBe(false);
		const takeover = await ledger.acquireLease("lease-owner-b", 30);
		expect(takeover.epoch).toBe(first.epoch + 1n);
		await ledger.close();
	});

	it("rejects forged acknowledge claims unless command, kind, and target match the locked outbox row", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const first = await json(await call(api, "POST", "/v1/workspaces", { key: "ack-binding-workspace-01", body: { name: "claimed" } }));
		const unrelated = await json(await call(api, "POST", "/v1/workspaces", { key: "ack-binding-workspace-02", body: { name: "unrelated" } }));
		const lease = await ledger.acquireLease("ack-binding-owner", 30);
		const claim = await ledger.claimNext(lease);
		expect(claim).toBeDefined();
		expect(claim!.targetId).toBe(first.id);
		const commands = await admin`SELECT command_id, idempotency_key, lifecycle_state FROM t4_commands WHERE idempotency_key IN ('ack-binding-workspace-01', 'ack-binding-workspace-02')` as Array<{ command_id: string; idempotency_key: string; lifecycle_state: string }>;
		const unrelatedCommandId = commands.find(row => row.idempotency_key === "ack-binding-workspace-02")!.command_id;

		expect(await ledger.acknowledge({ ...claim!, commandId: unrelatedCommandId })).toBe(false);
		expect(await ledger.acknowledge({ ...claim!, kind: "workspace.patch" })).toBe(false);
		expect(await ledger.acknowledge({ ...claim!, targetId: unrelated.id })).toBe(false);
		const unchanged = await admin`SELECT
			(SELECT state FROM t4_outbox WHERE outbox_id = ${claim!.outboxId}) AS outbox_state,
			(SELECT lifecycle_state FROM t4_commands WHERE command_id = ${claim!.commandId}) AS claimed_command_state,
			(SELECT lifecycle_state FROM t4_commands WHERE command_id = ${unrelatedCommandId}) AS unrelated_command_state` as Array<{ outbox_state: string; claimed_command_state: string; unrelated_command_state: string }>;
		expect(unchanged[0]).toEqual({ outbox_state: "claimed", claimed_command_state: "accepted", unrelated_command_state: "accepted" });
		expect(await ledger.acknowledge(claim!)).toBe(true);
		await ledger.close();
	});

	it("rejects claimed outbox rows with null or empty owners and nonpositive owner epochs at the table boundary", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		await call(api, "POST", "/v1/workspaces", { key: "claimed-row-constraint-01", body: { name: "claim constraints" } });
		const rows = await admin`SELECT outbox_id FROM t4_outbox WHERE idempotency_key = 'claimed-row-constraint-01'` as Array<{ outbox_id: bigint }>;
		const outboxId = rows[0]!.outbox_id;
		await expect(admin`UPDATE t4_outbox SET state = 'claimed', owner_id = NULL, owner_epoch = 1, claimed_at = clock_timestamp() WHERE outbox_id = ${outboxId}`).rejects.toMatchObject({ code: "23514" });
		await expect(admin`UPDATE t4_outbox SET state = 'claimed', owner_id = 'constraint-owner', owner_epoch = NULL, claimed_at = clock_timestamp() WHERE outbox_id = ${outboxId}`).rejects.toMatchObject({ code: "23514" });
		await expect(admin`UPDATE t4_outbox SET state = 'claimed', owner_id = 'constraint-owner', owner_epoch = 0, claimed_at = clock_timestamp() WHERE outbox_id = ${outboxId}`).rejects.toMatchObject({ code: "23514" });
		await expect(admin`UPDATE t4_outbox SET state = 'claimed', owner_id = '', owner_epoch = 1, claimed_at = clock_timestamp() WHERE outbox_id = ${outboxId}`).rejects.toMatchObject({ code: "23514" });
		await expect(admin`UPDATE t4_outbox SET state = 'claimed', owner_id = 'constraint-owner', owner_epoch = -1, claimed_at = clock_timestamp() WHERE outbox_id = ${outboxId}`).rejects.toMatchObject({ code: "23514" });
		const unchanged = await admin`SELECT state, owner_id, owner_epoch FROM t4_outbox WHERE outbox_id = ${outboxId}` as Array<{ state: string; owner_id: string | null; owner_epoch: bigint | null }>;
		expect(unchanged[0]).toEqual({ state: "pending", owner_id: null, owner_epoch: null });
		await ledger.close();
	});

	it("retries a current recordFailure serialization failure while preventing a stale owner from resetting the reclaimed item", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		await call(api, "POST", "/v1/workspaces", { key: "failure-takeover-workspace", body: { name: "failure takeover" } });
		const staleLease = await ledger.acquireLease("failure-stale-owner", 30);
		const staleClaim = await ledger.claimNext(staleLease);
		expect(staleClaim).toBeDefined();
		await admin`UPDATE t4_owner_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_name = 'gateway-outbox'`;
		const currentLease = await ledger.acquireLease("failure-current-owner", 30);
		const currentClaim = await ledger.claimNext(currentLease);
		expect(currentClaim?.outboxId).toBe(staleClaim!.outboxId);
		expect(currentClaim?.ownerEpoch).toBeGreaterThan(staleClaim!.ownerEpoch);

		expect(await ledger.recordFailure(staleClaim!, "late stale failure")).toBe(false);
		const retained = await admin`SELECT state, owner_id, owner_epoch, attempts, last_error FROM t4_outbox WHERE outbox_id = ${staleClaim!.outboxId}` as Array<{ state: string; owner_id: string; owner_epoch: bigint; attempts: number; last_error: string | null }>;
		expect(retained[0]).toEqual({ state: "claimed", owner_id: currentLease.ownerId, owner_epoch: currentLease.epoch, attempts: 2, last_error: null });

		let retryFixtureInstalled = false;
		try {
			await admin.unsafe(`
				CREATE SEQUENCE t4_test_record_failure_attempt;
				CREATE FUNCTION t4_test_fail_first_record_failure() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF OLD.state = 'claimed' AND NEW.state = 'pending' AND nextval('t4_test_record_failure_attempt') = 1 THEN
						RAISE EXCEPTION 'injected recordFailure serialization failure' USING ERRCODE = '40001';
					END IF;
					RETURN NEW;
				END $$;
				CREATE TRIGGER t4_test_fail_first_record_failure_trigger BEFORE UPDATE ON t4_outbox
				FOR EACH ROW EXECUTE FUNCTION t4_test_fail_first_record_failure();
			`);
			retryFixtureInstalled = true;
			expect(await ledger.recordFailure(currentClaim!, "retryable current failure")).toBe(true);
			const released = await admin`SELECT
				(SELECT last_value FROM t4_test_record_failure_attempt) AS retry_attempts,
				state, owner_id, owner_epoch, attempts, last_error
				FROM t4_outbox WHERE outbox_id = ${currentClaim!.outboxId}` as Array<{ retry_attempts: bigint; state: string; owner_id: string | null; owner_epoch: bigint | null; attempts: number; last_error: string | null }>;
			expect(released[0]).toEqual({ retry_attempts: 2n, state: "pending", owner_id: null, owner_epoch: null, attempts: 2, last_error: "retryable current failure" });
		} finally {
			if (retryFixtureInstalled) await admin.unsafe("DROP TRIGGER IF EXISTS t4_test_fail_first_record_failure_trigger ON t4_outbox; DROP FUNCTION IF EXISTS t4_test_fail_first_record_failure(); DROP SEQUENCE IF EXISTS t4_test_record_failure_attempt");
			await ledger.close();
		}
	});

	it("persists and exactly replays two distinct DELETE requests while enqueueing one provider deletion and one revision transition", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "double-delete-workspace-01", body: { name: "double delete" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "double-delete-session-001", body: { title: "double delete" } }));
		const firstKey = "double-delete-request-001";
		const secondKey = "double-delete-request-002";
		const first = await call(api, "DELETE", `/v1/sessions/${session.id}`, { key: firstKey });
		const second = await call(api, "DELETE", `/v1/sessions/${session.id}`, { key: secondKey });
		expect([first.status, second.status]).toEqual([204, 204]);
		expect([first.headers.get("idempotency-replayed"), second.headers.get("idempotency-replayed")]).toEqual(["false", "false"]);
		const firstBody = await first.text();
		const secondBody = await second.text();
		const firstReplay = await call(api, "DELETE", `/v1/sessions/${session.id}`, { key: firstKey });
		const secondReplay = await call(api, "DELETE", `/v1/sessions/${session.id}`, { key: secondKey });
		expect([firstReplay.status, secondReplay.status]).toEqual([204, 204]);
		expect([firstReplay.headers.get("idempotency-replayed"), secondReplay.headers.get("idempotency-replayed")]).toEqual(["true", "true"]);
		expect([await firstReplay.text(), await secondReplay.text()]).toEqual([firstBody, secondBody]);

		const persisted = await admin`SELECT
			(SELECT count(*) FROM t4_commands WHERE operation = 'deleteSession' AND target_scope = ${`session:${session.id}`}) AS commands,
			(SELECT count(*) FROM t4_outbox WHERE mutation_kind = 'session.delete' AND target_id = ${session.id}) AS deletions,
			(SELECT revision FROM t4_session_intents WHERE session_id = ${session.id}) AS revision,
			(SELECT generation FROM t4_session_intents WHERE session_id = ${session.id}) AS generation,
			(SELECT deletion_requested FROM t4_session_intents WHERE session_id = ${session.id}) AS deletion_requested` as Array<{ commands: bigint; deletions: bigint; revision: bigint; generation: bigint; deletion_requested: boolean }>;
		expect(persisted[0]).toEqual({ commands: 2n, deletions: 1n, revision: 2n, generation: 2n, deletion_requested: true });
		const kubernetes = new ObservableKubernetes();
		const worker = newWorker(ledger, "double-delete-owner", kubernetes);
		const lease = await worker.acquireLease();
		kubernetes.currentEpoch = lease.epoch;
		await worker.drain();
		expect(kubernetes.attempts.filter(mutation => mutation.kind === "session.delete" && mutation.targetId === session.id)).toHaveLength(1);
		await ledger.close();
	});

	it("reclaims a same-owner claim only after the named stale-apply deadline and immediately fences the abandoned claim", async () => {
		let ledger = await newLedger();
		let api = newApi(ledger);
		await call(api, "POST", "/v1/workspaces", { key: "same-owner-restart-claim", body: { name: "restart claim" } });
		const firstWorker = newWorker(ledger, "stable-restart-owner", new ObservableKubernetes());
		const firstLease = await firstWorker.acquireLease();
		const abandoned = await firstWorker.claimNext();
		expect(abandoned).toBeDefined();
		await ledger.close();

		ledger = await newLedger();
		api = newApi(ledger);
		const kubernetes = new ObservableKubernetes();
		const restarted = newWorker(ledger, "stable-restart-owner", kubernetes);
		const restartedLease = await restarted.acquireLease();
		expect(restartedLease).toEqual(firstLease);
		await expect(ledger.acquireLease("concurrent-thief", 30)).rejects.toThrow("lease");
		expect(await restarted.claimNext()).toBeUndefined();
		await admin`UPDATE t4_outbox SET claimed_at = clock_timestamp() - (${STALE_APPLY_DEADLINE_SECONDS - 1} * interval '1 second') WHERE outbox_id = ${abandoned!.outboxId}`;
		expect(await restarted.claimNext()).toBeUndefined();
		await admin`UPDATE t4_outbox SET claimed_at = clock_timestamp() - (${STALE_APPLY_DEADLINE_SECONDS + 1} * interval '1 second') WHERE outbox_id = ${abandoned!.outboxId}`;
		const reclaimed = await restarted.claimNext();
		expect(reclaimed?.outboxId).toBe(abandoned!.outboxId);
		expect(reclaimed?.ownerEpoch).toBe(firstLease.epoch);
		expect(await ledger.claimIsCurrent(abandoned!)).toBe(false);
		kubernetes.currentEpoch = restartedLease.epoch;
		expect(await restarted.applyClaim(reclaimed!)).toBe("applied");
		expect(kubernetes.attempts).toHaveLength(1);
		await ledger.close();
	});

	it("case-folds lowercase and mixed-case Bearer schemes without altering mixed-case credential bytes", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		for (const scheme of ["bearer", "bEaReR"]) {
			const requestHeaders = headers();
			requestHeaders.set("authorization", `${scheme} ${MIXED_CASE_OWNER_TOKEN}`);
			const response = await api.handle(new Request("https://t4.example.test/v1", { headers: requestHeaders }));
			expect(response.status).toBe(200);
		}
		await ledger.close();
	});

	it("returns the generated incompatible-version Error406 envelope for malformed or non-SSE Accept", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "accept-406-workspace-01", body: { name: "accept contract" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "accept-406-session-001", body: { title: "accept contract" } }));
		for (const accept of ["application/json", "text/event-stream;q=bogus"]) {
			const response = await call(api, "GET", `/v1/sessions/${session.id}/events`, { headers: { accept } });
			expect(response.status).toBe(406);
			expect(response.headers.get("content-type")).toContain("application/json");
			expect(response.headers.get("t4-api-version")).toBe("1.0");
			expect(await json(response)).toEqual({
				error: {
					code: "incompatible_version",
					message: expect.any(String),
					requestId: expect.stringMatching(/^req_[0-9a-f-]{36}$/u),
					retryable: false,
					supportedMajors: [1],
				},
			});
		}
		await ledger.close();
	});

	it("marks successful Kubernetes outbox application projected, never completed, while public command replay stays accepted", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "projected-workspace-0001", body: { name: "projected" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "projected-session-00001", body: { title: "projected" } }));
		const kubernetes = new ObservableKubernetes();
		const worker = newWorker(ledger, "projection-lifecycle-owner", kubernetes);
		const lease = await worker.acquireLease();
		kubernetes.currentEpoch = lease.epoch;
		expect(await worker.drain()).toBeGreaterThan(0);

		const key = "projected-command-00001";
		const input = { command: "printf projected", metadata: { contract: "lifecycle" } };
		const acceptedResponse = await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key, body: input });
		expect(acceptedResponse.status).toBe(202);
		const accepted = await json(acceptedResponse);
		expect(accepted).toMatchObject({ state: "accepted" });
		expect(await worker.drain()).toBe(1);
		const replay = await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key, body: input });
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotency-replayed")).toBe("true");
		expect(await json(replay)).toEqual(accepted);
		const lifecycle = await admin`SELECT command.lifecycle_state, item.state AS outbox_state
			FROM t4_commands command JOIN t4_outbox item USING (command_id)
			WHERE command.command_id = ${String(accepted.commandId)}` as Array<{ lifecycle_state: string; outbox_state: string }>;
		expect(lifecycle[0]).toEqual({ lifecycle_state: "projected", outbox_state: "applied" });
		expect(kubernetes.attempts.filter(mutation => mutation.kind === "command.submit" && mutation.targetId === session.id)).toHaveLength(1);
		await ledger.close();
	});

	it("atomically converges one complete session status event and opaque cursor while cancellation absorbs later status", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "status-ingress-workspace", body: { name: "status ingress" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "status-ingress-session-01", body: { title: "status ingress" } }));
		const lease = await ledger.acquireLease("status-ingress-owner", 30);
		const ingress = ledger as PostgresLedgerLike & AuthoritativeKubernetesStatusIngress;
		let rejectionTriggerInstalled = false;
		try {
			const eventsBeforeWorkspace = await admin`SELECT count(*) AS count FROM t4_events` as Array<{ count: bigint }>;
			await ingress.ingestKubernetesStatus(lease, "t4workspaces", {
				resourceId: workspace.id,
				principalId: "owner@example.com",
				uid: "workspace-authority-uid",
				resourceVersion: "workspace-rv-101",
				generation: 1n,
				observedGeneration: 1n,
				phase: "Ready",
			});
			const workspaceConvergence = await admin`SELECT
				(SELECT state FROM t4_workspace_intents WHERE workspace_id = ${workspace.id}) AS state,
				(SELECT count(*) FROM t4_events) AS event_count,
				(SELECT resource_version FROM t4_kubernetes_status_cursors WHERE collection = 't4workspaces') AS cursor` as Array<{ state: string; event_count: bigint; cursor: string }>;
			expect(workspaceConvergence[0]).toEqual({ state: "ready", event_count: eventsBeforeWorkspace[0]!.count, cursor: "workspace-rv-101" });

			const beforeSessionStatus = await admin`SELECT count(*) AS event_count, max(sequence) AS latest_event FROM t4_events WHERE session_id = ${session.id}` as Array<{ event_count: bigint; latest_event: bigint }>;
			await ingress.ingestKubernetesStatus(lease, "t4sessions", {
				resourceId: session.id,
				principalId: "owner@example.com",
				workspaceId: workspace.id,
				uid: "session-authority-uid",
				resourceVersion: "900",
				generation: 1n,
				observedGeneration: 1n,
				phase: "Running",
			});
			const converged = await admin`SELECT
				(SELECT state FROM t4_session_intents WHERE session_id = ${session.id}) AS state,
				(SELECT count(*) FROM t4_events WHERE session_id = ${session.id} AND sequence > ${beforeSessionStatus[0]!.latest_event}) AS new_event_count,
				(SELECT sequence FROM t4_events WHERE session_id = ${session.id} ORDER BY sequence DESC LIMIT 1) AS latest_event,
				(SELECT payload FROM t4_events WHERE session_id = ${session.id} ORDER BY sequence DESC LIMIT 1) AS event_payload,
				(SELECT owner_epoch FROM t4_events WHERE session_id = ${session.id} ORDER BY sequence DESC LIMIT 1) AS event_epoch,
				(SELECT latest_sequence FROM t4_event_retention WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}) AS retained_event,
				(SELECT resource_version FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor` as Array<{ state: string; new_event_count: bigint; latest_event: bigint; event_payload: Record<string, unknown>; event_epoch: bigint; retained_event: bigint; cursor: string }>;
			expect(converged[0]!.state).toBe("ready");
			expect(converged[0]!.new_event_count).toBe(1n);
			expect(converged[0]!.event_payload).toEqual({ state: "ready", revision: session.revision });
			expect(converged[0]!.event_epoch).toBe(lease.epoch);
			expect(converged[0]!.cursor).toBe("900");
			expect(converged[0]!.latest_event).toBeGreaterThan(beforeSessionStatus[0]!.latest_event);
			expect(converged[0]!.retained_event).toBe(converged[0]!.latest_event);

			await admin.unsafe(`
				CREATE OR REPLACE FUNCTION t4_test_reject_authoritative_status_event() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF NEW.event_type = 'session' AND NEW.payload->>'state' = 'failed' THEN RAISE EXCEPTION 'injected authoritative status event failure'; END IF;
					RETURN NEW;
				END $$;
				CREATE TRIGGER t4_test_reject_authoritative_status_event_trigger BEFORE INSERT ON t4_events
				FOR EACH ROW EXECUTE FUNCTION t4_test_reject_authoritative_status_event();
			`);
			rejectionTriggerInstalled = true;
			const beforeFailure = await admin`SELECT
				state, revision, kube_uid, kube_resource_version, kube_generation, kube_observed_generation,
				(SELECT count(*) FROM t4_events WHERE session_id = ${session.id}) AS event_count,
				(SELECT min(sequence) FROM t4_events WHERE session_id = ${session.id}) AS first_event,
				(SELECT max(sequence) FROM t4_events WHERE session_id = ${session.id}) AS latest_event,
				(SELECT first_retained_sequence FROM t4_event_retention WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}) AS first_retained_event,
				(SELECT latest_sequence FROM t4_event_retention WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}) AS latest_retained_event,
				(SELECT resource_version FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor_resource_version,
				(SELECT owner_epoch FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor_owner_epoch
				FROM t4_session_intents WHERE session_id = ${session.id}`;
			await expect(ingress.ingestKubernetesStatus(lease, "t4sessions", {
				resourceId: session.id,
				principalId: "owner@example.com",
				workspaceId: workspace.id,
				uid: "session-authority-uid",
				resourceVersion: "901",
				generation: 2n,
				observedGeneration: 2n,
				phase: "Failed",
			})).rejects.toThrow("injected authoritative status event failure");
			const afterFailure = await admin`SELECT
				state, revision, kube_uid, kube_resource_version, kube_generation, kube_observed_generation,
				(SELECT count(*) FROM t4_events WHERE session_id = ${session.id}) AS event_count,
				(SELECT min(sequence) FROM t4_events WHERE session_id = ${session.id}) AS first_event,
				(SELECT max(sequence) FROM t4_events WHERE session_id = ${session.id}) AS latest_event,
				(SELECT first_retained_sequence FROM t4_event_retention WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}) AS first_retained_event,
				(SELECT latest_sequence FROM t4_event_retention WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}) AS latest_retained_event,
				(SELECT resource_version FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor_resource_version,
				(SELECT owner_epoch FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor_owner_epoch
				FROM t4_session_intents WHERE session_id = ${session.id}`;
			expect(afterFailure).toEqual(beforeFailure);

			const cancellationResponse = await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "status-ingress-cancel-001" });
			expect(cancellationResponse.status).toBe(202);
			const cancelling = await json(cancellationResponse);
			expect(cancelling).toMatchObject({ id: session.id, state: "cancelling", revision: session.revision + 1 });
			const afterCancellation = await admin`SELECT count(*) AS event_count FROM t4_events WHERE session_id = ${session.id}` as Array<{ event_count: bigint }>;
			await ingress.ingestKubernetesStatus(lease, "t4sessions", {
				resourceId: session.id,
				principalId: "owner@example.com",
				workspaceId: workspace.id,
				uid: "session-authority-uid",
				resourceVersion: "10",
				generation: 1n,
				observedGeneration: 1n,
				phase: "Running",
			});
			const afterLowerOpaqueVersion = await admin`SELECT
				(SELECT state FROM t4_session_intents WHERE session_id = ${session.id}) AS state,
				(SELECT count(*) FROM t4_events WHERE session_id = ${session.id}) AS event_count,
				(SELECT resource_version FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor_resource_version,
				(SELECT owner_epoch FROM t4_kubernetes_status_cursors WHERE collection = 't4sessions') AS cursor_owner_epoch` as Array<{ state: string; event_count: bigint; cursor_resource_version: string; cursor_owner_epoch: bigint }>;
			expect(afterLowerOpaqueVersion[0]).toEqual({ state: "cancelling", event_count: afterCancellation[0]!.event_count, cursor_resource_version: "10", cursor_owner_epoch: lease.epoch });
		} finally {
			if (rejectionTriggerInstalled) await admin.unsafe("DROP TRIGGER IF EXISTS t4_test_reject_authoritative_status_event_trigger ON t4_events; DROP FUNCTION IF EXISTS t4_test_reject_authoritative_status_event()");
			await ledger.close();
		}
	});

	it("allows exact Unicode code-point bounds and denies browser Origin by default", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const astral = "😀".repeat(128);
		const exact = await call(api, "POST", "/v1/workspaces", {
			key: "unicode-codepoint-bound-01", body: { name: astral, labels: { emoji: astral } },
		});
		expect(exact.status).toBe(202);
		expect((await call(api, "POST", "/v1/workspaces", {
			key: "unicode-codepoint-bound-02", body: { name: `${astral}😀` },
		})).status).toBe(422);
		const browser = await call(api, "GET", "/v1", { headers: { origin: "https://browser.example.test" } });
		expect(browser.status).toBe(400);
		expect((await json(browser)).error.code).toBe("invalid_origin");
		expect((await call(api, "GET", "/v1")).status).toBe(200);
		const allowlisted = newApi(ledger, ["https://browser.example.test"]);
		expect((await call(allowlisted, "GET", "/v1", { headers: { origin: "https://browser.example.test" } })).status).toBe(200);
		expect((await call(allowlisted, "GET", "/v1", { headers: { origin: "https://other.example.test" } })).status).toBe(400);
		await ledger.close();
	});

	it("converges a paused stale session create followed by cancel and expired-lease takeover", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const kubernetes = new PausedCreateKubernetes();
		const stale = newWorker(ledger, "paused-owner", kubernetes);
		await stale.acquireLease();
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "paused-race-workspace-01", body: { name: "paused" } }));
		expect(await stale.drain()).toBe(1);
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "paused-race-session-001", body: { title: "paused" } }));
		const createClaim = await stale.claimNext();
		expect(createClaim).toBeDefined();
		const staleApply = stale.applyClaim(createClaim!);
		await kubernetes.createStarted.promise;
		expect((await call(api, "POST", `/v1/sessions/${session.id}/cancel`, { key: "paused-race-cancel-0001" })).status).toBe(202);
		await admin`UPDATE t4_owner_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_name = 'gateway-outbox'`;
		const current = newWorker(ledger, "takeover-owner", kubernetes);
		const currentLease = await current.acquireLease();
		expect(currentLease.epoch).toBeGreaterThan(createClaim!.ownerEpoch);
		kubernetes.releaseCreate.resolve();
		expect(await staleApply).toBe("fenced");
		expect(kubernetes.resources.has(session.id)).toBe(true);
		expect(await current.drain()).toBeGreaterThan(0);
		expect(kubernetes.resources.has(session.id)).toBe(false);
		await ledger.close();
	});

	it("reads snapshot entries and cursor from one database snapshot", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "atomic-snapshot-workspace", body: { name: "atomic snapshot" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "atomic-snapshot-session-1", body: { title: "atomic snapshot" } }));
		await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: "atomic-snapshot-command-1", body: { command: "before snapshot" } });
		const blocker = new SQL(DATABASE_URL!, { max: 1, bigint: true });
		await blocker`SELECT pg_advisory_lock(741407)`;
		await admin.unsafe(`
			CREATE SEQUENCE t4_test_snapshot_pause_reached;
			ALTER TABLE t4_event_retention RENAME TO t4_event_retention_base;
			CREATE FUNCTION t4_test_pause_snapshot(value bigint) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
			BEGIN PERFORM nextval('t4_test_snapshot_pause_reached'); PERFORM pg_advisory_xact_lock(741407); RETURN value; END $$;
			CREATE VIEW t4_event_retention AS
			SELECT principal_id, session_id, first_retained_sequence, t4_test_pause_snapshot(latest_sequence) AS latest_sequence, updated_at
			FROM t4_event_retention_base;
		`);
		const pendingSnapshot = call(api, "GET", `/v1/sessions/${session.id}/snapshot`);
		const concurrent = new SQL(DATABASE_URL!, { max: 1, bigint: true });
		const concurrentCommandId = "cmd_concurrent_snapshot_boundary";
		let snapshotResponse: Response | undefined;
		try {
			await waitForDatabase(async () => (await admin`SELECT is_called FROM t4_test_snapshot_pause_reached` as Array<{ is_called: boolean }>)[0]?.is_called === true);
			await concurrent.begin(async transaction => {
				const entries = await transaction<{ next: bigint }[]>`SELECT COALESCE(MAX(entry_sequence), -1) + 1 AS next FROM t4_snapshot_entries WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}`;
				await transaction`INSERT INTO t4_snapshot_entries (principal_id, session_id, entry_sequence, kind, text_value) VALUES ('owner@example.com', ${session.id}, ${entries[0]?.next ?? 0n}, 'input', 'concurrent snapshot command')`;
				const events = await transaction<{ sequence: bigint }[]>`INSERT INTO t4_events (principal_id, session_id, event_type, payload, owner_epoch) VALUES ('owner@example.com', ${session.id}, 'command', ${{ commandId: concurrentCommandId, state: "accepted" }}, 0) RETURNING sequence`;
				await transaction`UPDATE t4_event_retention_base SET latest_sequence = ${events[0]!.sequence}, updated_at = clock_timestamp() WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}`;
			});
			await blocker`SELECT pg_advisory_unlock(741407)`;
			snapshotResponse = await pendingSnapshot;
		} finally {
			await blocker.close();
			await Promise.allSettled([pendingSnapshot]);
			await concurrent.close();
			await admin.unsafe("DROP VIEW IF EXISTS t4_event_retention; ALTER TABLE t4_event_retention_base RENAME TO t4_event_retention; DROP FUNCTION IF EXISTS t4_test_pause_snapshot(bigint); DROP SEQUENCE IF EXISTS t4_test_snapshot_pause_reached");
		}
		expect(snapshotResponse).toBeDefined();
		expect(snapshotResponse!.status).toBe(200);
		const snapshot = await json(snapshotResponse!);
		const afterBoundary = await call(api, "GET", `/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(snapshot.cursor)}`, { headers: { accept: "text/event-stream" } });
		expect(afterBoundary.status).toBe(200);
		expect(eventData(await afterBoundary.text()).map(value => value.commandId)).toContain(concurrentCommandId);
		await ledger.close();
	});

	it("reads retention floor, events, and delivered cursor atomically across pruning", async () => {
		const ledger = await newLedger({ eventRetention: 100 });
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "atomic-window-workspace-1", body: { name: "atomic window" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "atomic-window-session-001", body: { title: "atomic window" } }));
		const snapshot = await json(await call(api, "GET", `/v1/sessions/${session.id}/snapshot`));
		const command = await json(await call(api, "POST", `/v1/sessions/${session.id}/commands`, { key: "atomic-window-command-001", body: { command: "must survive concurrent prune" } }));
		const target = await admin`SELECT sequence FROM t4_events WHERE principal_id = 'owner@example.com' AND session_id = ${session.id} AND payload->>'commandId' = ${command.commandId}` as Array<{ sequence: bigint }>;
		expect(target[0]).toBeDefined();
		const blocker = new SQL(DATABASE_URL!, { max: 1, bigint: true });
		const releaseBlocker = Promise.withResolvers<void>();
		const blockerReady = Promise.withResolvers<void>();
		const blockerTask = blocker.begin(async transaction => {
			await transaction`SELECT pg_advisory_xact_lock(741408)`;
			blockerReady.resolve();
			await releaseBlocker.promise;
		});
		await blockerReady.promise;
		await admin.unsafe(`
			CREATE SEQUENCE t4_test_event_pause_reached;
			ALTER TABLE t4_event_retention RENAME TO t4_event_retention_base;
			CREATE FUNCTION t4_test_pause_event(value bigint) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
			BEGIN PERFORM nextval('t4_test_event_pause_reached'); PERFORM pg_advisory_xact_lock(741408); RETURN value; END $$;
			CREATE VIEW t4_event_retention AS
			SELECT principal_id, session_id, first_retained_sequence, t4_test_pause_event(latest_sequence) AS latest_sequence, updated_at
			FROM t4_event_retention_base;
		`);
		const pendingWindow = call(api, "GET", `/v1/sessions/${session.id}/events?cursor=${encodeURIComponent(snapshot.cursor)}&maxEvents=1`, { headers: { accept: "text/event-stream" } });
		const concurrent = new SQL(DATABASE_URL!, { max: 1, bigint: true });
		let response: Response | undefined;
		try {
			await waitForDatabase(async () => (await admin`SELECT is_called FROM t4_test_event_pause_reached` as Array<{ is_called: boolean }>)[0]?.is_called === true);
			await concurrent.begin(async transaction => {
				await transaction`DELETE FROM t4_events WHERE sequence = ${target[0]!.sequence}`;
				await transaction`UPDATE t4_event_retention_base SET first_retained_sequence = ${target[0]!.sequence + 1n} WHERE principal_id = 'owner@example.com' AND session_id = ${session.id}`;
			});
			releaseBlocker.resolve();
			await blockerTask;
			response = await pendingWindow;
		} finally {
			releaseBlocker.resolve();
			await blockerTask;
			await blocker.close();
			await Promise.allSettled([pendingWindow]);
			await concurrent.close();
			await admin.unsafe("DROP VIEW IF EXISTS t4_event_retention; ALTER TABLE t4_event_retention_base RENAME TO t4_event_retention; DROP FUNCTION IF EXISTS t4_test_pause_event(bigint); DROP SEQUENCE IF EXISTS t4_test_event_pause_reached");
		}
		expect(response).toBeDefined();
		expect(response!.status).toBe(200);
		expect(eventData(await response!.text()).map(value => value.commandId)).toContain(command.commandId);
		await ledger.close();
	});

	it("stops a chunked request body as soon as the byte limit is crossed", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		let pulls = 0;
		let cancelledAt: number | undefined;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(600_000));
			},
			cancel() { cancelledAt = pulls; },
		});
		const response = await api.handle(new Request("https://t4.example.test/v1/workspaces", {
			method: "POST",
			headers: headers(OWNER_TOKEN, { "content-type": "application/json", "idempotency-key": "streaming-body-limit-key" }),
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" }));
		expect(response.status).toBe(400);
		expect((await json(response)).error.message).toContain("maximum size");
		expect(cancelledAt).toBeDefined();
		const pullsAfterCancellation = pulls;
		await Promise.resolve();
		expect(pulls).toBe(pullsAfterCancellation);
		await ledger.close();
	});

	it("requires an acceptable SSE media range and maps watch database failures to 503", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const workspace = await json(await call(api, "POST", "/v1/workspaces", { key: "sse-accept-workspace-01", body: { name: "sse accept" } }));
		const session = await json(await call(api, "POST", `/v1/workspaces/${workspace.id}/sessions`, { key: "sse-accept-session-001", body: { title: "sse accept" } }));
		for (const accept of [undefined, "application/json", "text/plain;q=1, text/event-stream;q=0"]) {
			const response = await call(api, "GET", `/v1/sessions/${session.id}/events`, accept ? { headers: { accept } } : {});
			expect(response.status).toBe(406);
		}
		expect((await call(api, "GET", `/v1/sessions/${session.id}/events`, { headers: { accept: "text/event-stream, application/json;q=0.5" } })).status).toBe(200);
		expect((await call(api, "GET", `/v1/sessions/${session.id}/events?cursor=invalid`, { headers: { accept: "text/event-stream" } })).status).toBe(422);
		await admin`ALTER TABLE t4_event_retention RENAME TO t4_event_retention_unavailable`;
		const unavailable = await call(api, "GET", `/v1/sessions/${session.id}/events`, { headers: { accept: "text/event-stream" } });
		expect(unavailable.status).toBe(503);
		expect((await json(unavailable)).error).toMatchObject({ code: "unavailable", retryable: true });
		await admin`ALTER TABLE t4_event_retention_unavailable RENAME TO t4_event_retention`;
		await ledger.close();
	});

	it("rejects authenticated principals that cannot be projected into CRD spec.owner", async () => {
		const ledger = await newLedger();
		const api = newApi(ledger);
		const before = await admin`SELECT count(*) AS count FROM t4_commands` as Array<{ count: bigint }>;
		const response = await call(api, "POST", "/v1/workspaces", {
			token: INVALID_PRINCIPAL_TOKEN,
			key: "invalid-principal-owner-01",
			body: { name: "must not commit" },
		});
		expect(response.status).toBe(401);
		const after = await admin`SELECT count(*) AS count FROM t4_commands` as Array<{ count: bigint }>;
		expect(after).toEqual(before);
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
