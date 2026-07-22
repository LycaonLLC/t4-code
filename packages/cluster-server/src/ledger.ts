import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SQL } from "bun";

export interface DurableLedgerOptions {
	readonly url: string;
	readonly cursorSecret: string;
	readonly eventRetention?: number;
}
export interface WorkspaceRecord {
	readonly id: string;
	readonly name: string;
	readonly state: "accepted" | "provisioning" | "ready" | "deleting" | "deleted" | "failed" | "unavailable" | "indeterminate";
	readonly revision: number;
	readonly labels?: Readonly<Record<string, string>>;
}
export interface SessionRecord {
	readonly id: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly state: "accepted" | "provisioning" | "ready" | "cancelling" | "cancelled" | "failed" | "unavailable" | "indeterminate";
	readonly revision: number;
	readonly labels?: Readonly<Record<string, string>>;
}
export interface LedgerMutationResult<T> {
	readonly kind: "accepted" | "replay" | "idempotency_conflict" | "revision_conflict" | "not_found";
	readonly commandId?: string;
	readonly value?: T;
}
export interface DurableEvent {
	readonly sequence: bigint;
	readonly type: "session" | "command";
	readonly payload: Readonly<Record<string, unknown>>;
}
export interface EventWindow {
	readonly events: readonly DurableEvent[];
	readonly cursor: string;
	readonly expired: boolean;
	readonly resyncCursor: string;
}
export interface OutboxClaim {
	readonly outboxId: bigint;
	readonly commandId: string;
	readonly principalId: string;
	readonly idempotencyKey: string;
	readonly kind: "workspace.create" | "workspace.patch" | "workspace.delete" | "session.create" | "session.patch" | "session.cancel" | "session.delete" | "command.submit";
	readonly targetId: string;
	readonly targetRevision: bigint;
	readonly mutation: Readonly<Record<string, unknown>>;
	readonly ownerId: string;
	readonly ownerEpoch: bigint;
	readonly expiresAt: number;
	readonly claimedAt: string;
}
export interface OwnerLease {
	readonly ownerId: string;
	readonly epoch: bigint;
}
export type KubernetesStatusCollection = "t4workspaces" | "t4sessions";
export interface AuthoritativeKubernetesStatusObservation {
	readonly resourceId: string;
	readonly principalId: string;
	readonly workspaceId?: string;
	readonly uid: string;
	readonly resourceVersion: string;
	readonly generation: bigint;
	readonly observedGeneration: bigint;
	readonly phase: "Pending" | "Ready" | "Running" | "Failed" | "Terminating" | "Unknown";
	readonly deleted?: boolean;
}
export interface AuthoritativeKubernetesStatusSnapshot {
	readonly relisted: true;
	readonly resourceVersion: string;
	readonly resourceIds: readonly string[];
}
export type AuthoritativeKubernetesStatusIngress = AuthoritativeKubernetesStatusObservation | AuthoritativeKubernetesStatusSnapshot;
export interface StaleCreateCleanup {
	readonly resourceType: KubernetesStatusCollection;
	readonly targetId: string;
	readonly uid: string;
	readonly resourceVersion: string;
}
export interface StaleCreateCleanupClaim extends StaleCreateCleanup {
	readonly cleanupId: bigint;
	readonly ownerId: string;
	readonly ownerEpoch: bigint;
	readonly expiresAt: number;
	readonly claimedAt: string;
}

interface CommandRow {
	readonly fingerprint: string;
	readonly response_body: unknown;
}
interface WorkspaceRow {
	readonly workspace_id: string;
	readonly name: string;
	readonly state: WorkspaceRecord["state"];
	readonly revision: bigint;
	readonly labels: Record<string, string>;
}
interface SessionRow {
	readonly session_id: string;
	readonly workspace_id: string;
	readonly title: string;
	readonly state: SessionRecord["state"];
	readonly revision: bigint;
	readonly labels: Record<string, string>;
	readonly cancellation_requested: boolean;
	readonly deletion_requested: boolean;
}
interface EventRow {
	readonly sequence: bigint;
	readonly event_type: "session" | "command";
	readonly payload: Record<string, unknown>;
}
interface RetentionRow { readonly first_retained_sequence: bigint; readonly latest_sequence: bigint; }
interface LeaseRow { readonly owner_id: string; readonly epoch: bigint; readonly expired: boolean; }
interface OutboxRow {
	readonly outbox_id: bigint;
	readonly command_id: string;
	readonly principal_id: string;
	readonly idempotency_key: string;
	readonly mutation_kind: OutboxClaim["kind"];
	readonly target_id: string;
	readonly target_revision: bigint;
	readonly mutation: Record<string, unknown>;
}
interface LockedOutboxRow extends OutboxRow {
	readonly state: "pending" | "claimed" | "applied" | "skipped" | "failed";
	readonly owner_id: string | null;
	readonly owner_epoch: bigint | null;
	readonly claimed_at: string | null;
}
interface CleanupRow {
	readonly cleanup_id: bigint;
	readonly resource_type: KubernetesStatusCollection;
	readonly target_id: string;
	readonly uid: string;
	readonly resource_version: string;
}
interface MissingWorkspaceStatusRow { readonly workspace_id: string; }
interface MissingSessionStatusRow { readonly session_id: string; readonly principal_id: string; readonly revision: bigint; }
interface KubernetesStatusRow {
	readonly state: WorkspaceRecord["state"] | SessionRecord["state"];
	readonly revision: bigint;
	readonly generation: bigint;
	readonly kube_uid: string | null;
	readonly kube_resource_version: string | null;
	readonly kube_generation: bigint | null;
	readonly kube_observed_generation: bigint | null;
	readonly cancellation_requested?: boolean;
	readonly deletion_requested: boolean;
}

const MIGRATION_URL = new URL("../migrations/001_durable_gateway.sql", import.meta.url);
const ROLLBACK_URL = new URL("../migrations/001_durable_gateway.down.sql", import.meta.url);
const OUTBOX_LEASE = "gateway-outbox";
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const SERIALIZABLE_ATTEMPTS = 3;
const STALE_APPLY_DEADLINE_SECONDS = 5;

function persistedBigint(value: unknown, allowZero = false): bigint {
	if (typeof value !== "bigint") throw new Error("persisted ledger bigint is invalid");
	if (allowZero ? value < 0n : value <= 0n) throw new Error("persisted ledger bigint is invalid");
	return value;
}
function safeNumber(value: unknown, allowZero = false): number {
	const decoded = persistedBigint(value, allowZero);
	if (decoded > MAX_SAFE_BIGINT) throw new Error("persisted ledger integer is outside the public API range");
	return Number(decoded);
}
function postgresSqlState(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as { readonly code?: unknown; readonly errno?: unknown };
	if (typeof value.code === "string" && /^[0-9A-Z]{5}$/u.test(value.code)) return value.code;
	return typeof value.errno === "string" && /^[0-9A-Z]{5}$/u.test(value.errno) ? value.errno : undefined;
}
function isIdempotencyUniqueRace(error: unknown): boolean {
	if (postgresSqlState(error) !== "23505" || !error || typeof error !== "object") return false;
	const value = error as { readonly constraint?: unknown; readonly constraint_name?: unknown };
	const constraint = value.constraint ?? value.constraint_name;
	return constraint === "t4_commands_principal_id_operation_target_scope_idempotency_key";
}
function labels(value: Record<string, string>): Record<string, string> | undefined {
	return Object.keys(value).length > 0 ? value : undefined;
}
function workspace(row: WorkspaceRow): WorkspaceRecord {
	return { id: row.workspace_id, name: row.name, state: row.state, revision: safeNumber(row.revision), ...(labels(row.labels) ? { labels: labels(row.labels) } : {}) };
}
function session(row: SessionRow): SessionRecord {
	return { id: row.session_id, workspaceId: row.workspace_id, title: row.title, state: row.state, revision: safeNumber(row.revision), ...(labels(row.labels) ? { labels: labels(row.labels) } : {}) };
}
function stableJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain a non-finite number");
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	throw new Error("canonical JSON value is invalid");
}
function semanticJsonEqual(left: unknown, right: unknown): boolean {
	try { return stableJson(left) === stableJson(right); }
	catch { return false; }
}
export function canonicalRequestFingerprint(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

export class PostgresLedger {
	readonly #sql: SQL;
	readonly #cursorSecret: Uint8Array;
	readonly #eventRetention: number;

	constructor(options: DurableLedgerOptions) {
		const secret = new TextEncoder().encode(options.cursorSecret);
		if (secret.byteLength < 32 || secret.byteLength > 4096) throw new Error("cursor secret must contain 32 to 4096 UTF-8 bytes");
		this.#cursorSecret = secret;
		this.#eventRetention = options.eventRetention ?? 10_000;
		if (!Number.isSafeInteger(this.#eventRetention) || this.#eventRetention < 1 || this.#eventRetention > 100_000) throw new Error("event retention is invalid");
		this.#sql = new SQL(options.url, { bigint: true, max: 8 });
	}

	async migrate(): Promise<void> {
		const migration = await Bun.file(MIGRATION_URL).text();
		await this.#serializable(async transaction => {
			await transaction`SELECT pg_advisory_xact_lock(741405)`;
			await transaction.unsafe(migration);
		});
		const rows = await this.#sql<{ version: number }[]>`SELECT version FROM t4_schema_migrations ORDER BY version DESC LIMIT 1`;
		if (rows[0]?.version !== 1) throw new Error("durable gateway schema migration did not reach version 1");
	}
	async rollback(): Promise<void> {
		const rollback = await Bun.file(ROLLBACK_URL).text();
		await this.#serializable(async transaction => {
			await transaction`SELECT pg_advisory_xact_lock(741405)`;
			await transaction.unsafe(rollback);
		});
	}
	async close(): Promise<void> { await this.#sql.close(); }

	async createWorkspace(principalId: string, idempotencyKey: string, fingerprint: string, input: { name: string; labels?: Record<string, string> }): Promise<LedgerMutationResult<WorkspaceRecord>> {
		return await this.#serializable(async transaction => {
			await this.#lockIdempotency(transaction, principalId, "createWorkspace", "workspaces", idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'createWorkspace' AND target_scope = 'workspaces' AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint
				? { kind: "replay", value: prior[0].response_body as WorkspaceRecord }
				: { kind: "idempotency_conflict" };
			const commandId = `cmd_${randomUUID()}`;
			const workspaceId = `ws-${randomUUID()}`;
			const value: WorkspaceRecord = { id: workspaceId, name: input.name, state: "accepted", revision: 1, ...(input.labels ? { labels: input.labels } : {}) };
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'createWorkspace', 'workspaces', ${idempotencyKey}, ${fingerprint}, 'accepted', 202, ${value})`;
			await transaction`INSERT INTO t4_workspace_intents (workspace_id, principal_id, name, labels, state, revision, generation) VALUES (${workspaceId}, ${principalId}, ${input.name}, ${input.labels ?? {}}, 'accepted', 1, 1)`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'workspace.create', ${workspaceId}, 1, ${value})`;
			return { kind: "accepted", commandId, value };
		});
	}

	async getWorkspace(principalId: string, workspaceId: string): Promise<WorkspaceRecord | undefined> {
		const rows = await this.#sql<WorkspaceRow[]>`SELECT workspace_id, name, state, revision, labels FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND state <> 'deleted'`;
		return rows[0] ? workspace(rows[0]) : undefined;
	}
	async listWorkspaces(principalId: string, afterId: string | undefined, limit: number): Promise<readonly WorkspaceRecord[]> {
		const rows = afterId
			? await this.#sql<WorkspaceRow[]>`SELECT workspace_id, name, state, revision, labels FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id > ${afterId} AND state <> 'deleted' ORDER BY workspace_id LIMIT ${limit}`
			: await this.#sql<WorkspaceRow[]>`SELECT workspace_id, name, state, revision, labels FROM t4_workspace_intents WHERE principal_id = ${principalId} AND state <> 'deleted' ORDER BY workspace_id LIMIT ${limit}`;
		return rows.map(workspace);
	}

	async patchWorkspace(principalId: string, workspaceId: string, expectedRevision: number, idempotencyKey: string, fingerprint: string, input: { name?: string; labels?: Record<string, string> }): Promise<LedgerMutationResult<WorkspaceRecord>> {
		return await this.#serializable(async transaction => {
			const scope = `workspace:${workspaceId}`;
			await this.#lockIdempotency(transaction, principalId, "mutateWorkspace", scope, idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'mutateWorkspace' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as WorkspaceRecord } : { kind: "idempotency_conflict" };
			const rows = await transaction<WorkspaceRow[]>`SELECT workspace_id, name, state, revision, labels FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND state <> 'deleted' FOR UPDATE`;
			const current = rows[0];
			if (!current) return { kind: "not_found" };
			if (current.revision !== BigInt(expectedRevision)) return { kind: "revision_conflict" };
			const revision = current.revision + 1n;
			const value: WorkspaceRecord = { id: workspaceId, name: input.name ?? current.name, state: current.state, revision: safeNumber(revision), ...(input.labels ?? labels(current.labels) ? { labels: input.labels ?? current.labels } : {}) };
			const commandId = `cmd_${randomUUID()}`;
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'mutateWorkspace', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 200, ${value})`;
			await transaction`UPDATE t4_workspace_intents SET name = ${value.name}, labels = ${value.labels ?? {}}, revision = ${revision}, generation = generation + 1, updated_at = clock_timestamp() WHERE workspace_id = ${workspaceId}`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'workspace.patch', ${workspaceId}, ${revision}, ${value})`;
			return { kind: "accepted", commandId, value };
		});
	}

	async deleteWorkspace(principalId: string, workspaceId: string, idempotencyKey: string, fingerprint: string): Promise<LedgerMutationResult<undefined>> {
		return await this.#serializable(async transaction => {
			const scope = `workspace:${workspaceId}`;
			await this.#lockIdempotency(transaction, principalId, "deleteWorkspace", scope, idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'deleteWorkspace' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay" } : { kind: "idempotency_conflict" };
			const rows = await transaction<WorkspaceRow[]>`SELECT workspace_id, name, state, revision, labels FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND state <> 'deleted' FOR UPDATE`;
			if (!rows[0]) return { kind: "not_found" };
			const revision = rows[0].revision + 1n;
			const commandId = `cmd_${randomUUID()}`;
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status) VALUES (${commandId}, ${principalId}, 'deleteWorkspace', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 204)`;
			await transaction`UPDATE t4_workspace_intents SET state = 'deleting', deletion_requested = true, revision = ${revision}, generation = generation + 1, updated_at = clock_timestamp() WHERE workspace_id = ${workspaceId}`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'workspace.delete', ${workspaceId}, ${revision}, ${{ workspaceId }})`;
			return { kind: "accepted", commandId };
		});
	}

	async createSession(principalId: string, workspaceId: string, idempotencyKey: string, fingerprint: string, input: { title: string; labels?: Record<string, string> }): Promise<LedgerMutationResult<SessionRecord>> {
		return await this.#serializable(async transaction => {
			const scope = `workspace:${workspaceId}:sessions`;
			await this.#lockIdempotency(transaction, principalId, "spawnSession", scope, idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'spawnSession' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as SessionRecord } : { kind: "idempotency_conflict" };
			const workspaceRows = await transaction<{ workspace_id: string }[]>`SELECT workspace_id FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND state NOT IN ('deleting','deleted') FOR UPDATE`;
			if (!workspaceRows[0]) return { kind: "not_found" };
			const commandId = `cmd_${randomUUID()}`;
			const sessionId = `ss-${randomUUID()}`;
			const value: SessionRecord = { id: sessionId, workspaceId, title: input.title, state: "accepted", revision: 1, ...(input.labels ? { labels: input.labels } : {}) };
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'spawnSession', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 202, ${value})`;
			await transaction`INSERT INTO t4_session_intents (session_id, workspace_id, principal_id, title, labels, state, revision, generation) VALUES (${sessionId}, ${workspaceId}, ${principalId}, ${input.title}, ${input.labels ?? {}}, 'accepted', 1, 1)`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'session.create', ${sessionId}, 1, ${value})`;
			await this.#appendEvent(transaction, principalId, sessionId, "session", { state: "accepted", revision: 1 }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async getSession(principalId: string, sessionId: string): Promise<SessionRecord | undefined> {
		const rows = await this.#sql<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
		return rows[0] ? session(rows[0]) : undefined;
	}
	async listSessions(principalId: string, workspaceId: string, afterId: string | undefined, limit: number): Promise<readonly SessionRecord[] | undefined> {
		if (!await this.getWorkspace(principalId, workspaceId)) return undefined;
		const rows = afterId
			? await this.#sql<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND session_id > ${afterId} ORDER BY session_id LIMIT ${limit}`
			: await this.#sql<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} ORDER BY session_id LIMIT ${limit}`;
		return rows.map(session);
	}

	async patchSession(principalId: string, sessionId: string, expectedRevision: number, idempotencyKey: string, fingerprint: string, input: { title?: string; labels?: Record<string, string> }): Promise<LedgerMutationResult<SessionRecord>> {
		return await this.#serializable(async transaction => {
			const scope = `session:${sessionId}`;
			await this.#lockIdempotency(transaction, principalId, "mutateSession", scope, idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'mutateSession' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as SessionRecord } : { kind: "idempotency_conflict" };
			const rows = await transaction<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND state NOT IN ('cancelling','cancelled','failed','unavailable','indeterminate') FOR UPDATE`;
			const current = rows[0];
			if (!current) return { kind: "not_found" };
			if (current.revision !== BigInt(expectedRevision)) return { kind: "revision_conflict" };
			const revision = current.revision + 1n;
			const value: SessionRecord = { id: sessionId, workspaceId: current.workspace_id, title: input.title ?? current.title, state: current.state, revision: safeNumber(revision), ...(input.labels ?? labels(current.labels) ? { labels: input.labels ?? current.labels } : {}) };
			const commandId = `cmd_${randomUUID()}`;
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'mutateSession', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 200, ${value})`;
			await transaction`UPDATE t4_session_intents SET title = ${value.title}, labels = ${value.labels ?? {}}, revision = ${revision}, generation = generation + 1, updated_at = clock_timestamp() WHERE session_id = ${sessionId}`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'session.patch', ${sessionId}, ${revision}, ${value})`;
			await this.#appendEvent(transaction, principalId, sessionId, "session", { state: value.state, revision: value.revision }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async cancelSession(principalId: string, sessionId: string, idempotencyKey: string, fingerprint: string, deletion = false): Promise<LedgerMutationResult<SessionRecord>> {
		return await this.#serializable(async transaction => {
			const operation = deletion ? "deleteSession" : "cancelSession";
			const scope = `session:${sessionId}`;
			await this.#lockIdempotency(transaction, principalId, operation, scope, idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = ${operation} AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as SessionRecord } : { kind: "idempotency_conflict" };
			const rows = await transaction<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested, deletion_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId} FOR UPDATE`;
			const current = rows[0];
			if (!current) return { kind: "not_found" };
			if (current.cancellation_requested || current.state === "cancelling" || current.state === "cancelled" || current.state === "failed" || current.state === "unavailable" || current.state === "indeterminate") {
				const value = session(current);
				const commandId = `cmd_${randomUUID()}`;
				const dispatchDeletion = deletion && !current.deletion_requested;
				await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, ${operation}, ${scope}, ${idempotencyKey}, ${fingerprint}, ${dispatchDeletion ? "accepted" : "projected"}, ${deletion ? 204 : 202}, ${value})`;
				if (dispatchDeletion) {
					await transaction`UPDATE t4_session_intents SET deletion_requested = true, generation = generation + 1, updated_at = clock_timestamp() WHERE session_id = ${sessionId}`;
					await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'session.delete', ${sessionId}, ${current.revision}, ${{ sessionId, revision: safeNumber(current.revision) }})`;
				}
				await this.#terminalizePendingSessionCommands(transaction, principalId, sessionId, "session cancelled or deleted", 0n);
				await this.#appendEvent(transaction, principalId, sessionId, "session", { state: current.state, revision: safeNumber(current.revision) }, 0n);
				return { kind: "accepted", commandId, value };
			}
			const revision = current.revision + 1n;
			const value: SessionRecord = { id: sessionId, workspaceId: current.workspace_id, title: current.title, state: "cancelling", revision: safeNumber(revision), ...(labels(current.labels) ? { labels: current.labels } : {}) };
			const commandId = `cmd_${randomUUID()}`;
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, ${operation}, ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', ${deletion ? 204 : 202}, ${value})`;
			await transaction`UPDATE t4_session_intents SET state = 'cancelling', cancellation_requested = true, deletion_requested = deletion_requested OR ${deletion}, revision = ${revision}, generation = generation + 1, updated_at = clock_timestamp() WHERE session_id = ${sessionId}`;
			await transaction`UPDATE t4_outbox SET state = 'skipped', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, terminal_result = ${{ reason: "superseded by cancellation" }}, updated_at = clock_timestamp() WHERE target_id = ${sessionId} AND mutation_kind = 'session.create' AND state IN ('pending','claimed')`;
			await this.#terminalizePendingSessionCommands(transaction, principalId, sessionId, "session cancelled or deleted", 0n);
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, ${deletion ? "session.delete" : "session.cancel"}, ${sessionId}, ${revision}, ${{ sessionId, revision: safeNumber(revision) }})`;
			await this.#appendEvent(transaction, principalId, sessionId, "session", { state: "cancelling", revision: safeNumber(revision) }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async submitCommand(principalId: string, sessionId: string, idempotencyKey: string, fingerprint: string, input: { command: string; metadata: Record<string, string | number | boolean | null> }): Promise<LedgerMutationResult<{ commandId: string; state: "accepted" }>> {
		return await this.#serializable(async transaction => {
			const scope = `session:${sessionId}:commands`;
			await this.#lockIdempotency(transaction, principalId, "submitCommand", scope, idempotencyKey);
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'submitCommand' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as { commandId: string; state: "accepted" } } : { kind: "idempotency_conflict" };
			const sessionRows = await transaction<{ session_id: string }[]>`SELECT session_id FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND state NOT IN ('cancelling','cancelled','failed','unavailable','indeterminate') FOR UPDATE`;
			if (!sessionRows[0]) return { kind: "not_found" };
			const commandId = `cmd_${randomUUID()}`;
			const value = { commandId, state: "accepted" as const };
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'submitCommand', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 202, ${value})`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) SELECT ${commandId}, ${principalId}, ${idempotencyKey}, 'command.submit', ${sessionId}, revision, ${{ sessionId, ...input }} FROM t4_session_intents WHERE session_id = ${sessionId}`;
			const entryRows = await transaction<{ next: bigint }[]>`SELECT COALESCE(MAX(entry_sequence), -1) + 1 AS next FROM t4_snapshot_entries WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
			await transaction`INSERT INTO t4_snapshot_entries (principal_id, session_id, entry_sequence, kind, text_value) VALUES (${principalId}, ${sessionId}, ${entryRows[0]?.next ?? 0n}, 'input', ${input.command})`;
			await this.#appendEvent(transaction, principalId, sessionId, "command", { commandId, state: "accepted" }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async snapshot(principalId: string, sessionId: string): Promise<{ session: SessionRecord; cursor: string; entries: readonly { sequence: number; kind: "input" | "output" | "status"; text: string }[] } | undefined> {
		return await this.#sql.begin("ISOLATION LEVEL REPEATABLE READ", async rawTransaction => {
			const transaction = rawTransaction as unknown as SQL;
			const sessionRows = await transaction<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
			if (!sessionRows[0]) return undefined;
			const rows = await transaction<{ entry_sequence: bigint; kind: "input" | "output" | "status"; text_value: string }[]>`SELECT entry_sequence, kind, text_value FROM t4_snapshot_entries WHERE principal_id = ${principalId} AND session_id = ${sessionId} ORDER BY entry_sequence DESC LIMIT 1000`;
			const retention = await transaction<RetentionRow[]>`SELECT first_retained_sequence, latest_sequence FROM t4_event_retention WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
			const latest = retention[0] ? persistedBigint(retention[0].latest_sequence, true) : 0n;
			return { session: session(sessionRows[0]), cursor: this.watchCursor(principalId, sessionId, latest), entries: rows.reverse().map(row => ({ sequence: safeNumber(row.entry_sequence, true), kind: row.kind, text: row.text_value })) };
		});
	}

	async eventWindow(principalId: string, sessionId: string, cursor: string | undefined, limit: number): Promise<EventWindow | undefined> {
		let after = 0n;
		if (cursor !== undefined) {
			const decoded = this.#decodeCursor(cursor, "watch", principalId, sessionId);
			if (typeof decoded !== "bigint") throw new Error("invalid_cursor");
			after = decoded;
		}
		return await this.#sql.begin("ISOLATION LEVEL REPEATABLE READ", async rawTransaction => {
			const transaction = rawTransaction as unknown as SQL;
			const sessionRows = await transaction<{ session_id: string }[]>`SELECT session_id FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
			if (!sessionRows[0]) return undefined;
			const retentionRows = await transaction<RetentionRow[]>`SELECT first_retained_sequence, latest_sequence FROM t4_event_retention WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
			const first = retentionRows[0] ? persistedBigint(retentionRows[0].first_retained_sequence, true) : 0n;
			const latest = retentionRows[0] ? persistedBigint(retentionRows[0].latest_sequence, true) : 0n;
			const resyncCursor = this.watchCursor(principalId, sessionId, latest);
			if (cursor !== undefined && first > 0n && after < first - 1n) return { events: [], cursor: resyncCursor, expired: true, resyncCursor };
			const rows = await transaction<EventRow[]>`SELECT sequence, event_type, payload FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND sequence > ${after} ORDER BY sequence LIMIT ${limit}`;
			const delivered = rows.at(-1) ? persistedBigint(rows.at(-1)!.sequence) : after;
			return { events: rows.map(row => ({ sequence: persistedBigint(row.sequence), type: row.event_type, payload: row.payload })), cursor: this.watchCursor(principalId, sessionId, delivered), expired: false, resyncCursor };
		});
	}

	watchCursor(principalId: string, sessionId: string, sequence: bigint): string { return this.#cursor("watch", principalId, sessionId, sequence); }
	pageCursor(principalId: string, scope: string, id: string): string { return this.#cursor("page", principalId, scope, id); }
	readPageCursor(cursor: string, principalId: string, scope: string): string | undefined {
		const result = this.#decodeCursor(cursor, "page", principalId, scope);
		return typeof result === "string" ? result : undefined;
	}

	async tryAcquireLease(ownerId: string, leaseSeconds = 30): Promise<OwnerLease | undefined> {
		if (!ownerId.trim() || Buffer.byteLength(ownerId, "utf8") > 256) throw new Error("outbox owner id is invalid");
		if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error("outbox lease duration is invalid");
		const rows = await this.#serializable(async transaction => {
			const current = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (!current[0]) return await transaction<LeaseRow[]>`INSERT INTO t4_owner_leases (lease_name, owner_id, epoch, expires_at) VALUES (${OUTBOX_LEASE}, ${ownerId}, 1, clock_timestamp() + (${leaseSeconds} * interval '1 second')) RETURNING owner_id, epoch, false AS expired`;
			if (current[0].owner_id === ownerId && !current[0].expired) return await transaction<LeaseRow[]>`UPDATE t4_owner_leases SET expires_at = clock_timestamp() + (${leaseSeconds} * interval '1 second'), updated_at = clock_timestamp() WHERE lease_name = ${OUTBOX_LEASE} RETURNING owner_id, epoch, false AS expired`;
			if (!current[0].expired) return undefined;
			return await transaction<LeaseRow[]>`UPDATE t4_owner_leases SET owner_id = ${ownerId}, epoch = epoch + 1, expires_at = clock_timestamp() + (${leaseSeconds} * interval '1 second'), updated_at = clock_timestamp() WHERE lease_name = ${OUTBOX_LEASE} RETURNING owner_id, epoch, false AS expired`;
		});
		return rows?.[0] ? { ownerId: rows[0].owner_id, epoch: persistedBigint(rows[0].epoch) } : undefined;
	}

	async acquireLease(ownerId: string, leaseSeconds = 30): Promise<OwnerLease> {
		const lease = await this.tryAcquireLease(ownerId, leaseSeconds);
		if (!lease) throw new Error("outbox lease is held by another owner");
		return lease;
	}

	async claimNext(lease: OwnerLease): Promise<OutboxClaim | undefined> {
		return await this.#serializable(async transaction => {
			const current = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (current[0]?.owner_id !== lease.ownerId || current[0].epoch !== lease.epoch || current[0].expired) return undefined;
			const rows = await transaction<OutboxRow[]>`SELECT outbox_id, command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation FROM t4_outbox WHERE (state = 'pending' OR (state = 'claimed' AND owner_epoch < ${lease.epoch}) OR (state = 'claimed' AND owner_id = ${lease.ownerId} AND owner_epoch = ${lease.epoch} AND claimed_at <= clock_timestamp() - (${STALE_APPLY_DEADLINE_SECONDS} * interval '1 second'))) AND next_attempt_at <= clock_timestamp() ORDER BY outbox_id FOR UPDATE SKIP LOCKED LIMIT 1`;
			const row = rows[0];
			if (!row) return undefined;
			let superseded = false;
			if (row.mutation_kind.startsWith("session.")) {
				const intent = await transaction<{ revision: bigint; cancellation_requested: boolean }[]>`SELECT revision, cancellation_requested FROM t4_session_intents WHERE session_id = ${row.target_id}`;
				superseded = !intent[0] || intent[0].revision !== row.target_revision || row.mutation_kind === "session.create" && intent[0].cancellation_requested;
			} else if (row.mutation_kind === "command.submit") {
				const intent = await transaction<{ state: SessionRecord["state"]; cancellation_requested: boolean; deletion_requested: boolean }[]>`SELECT state, cancellation_requested, deletion_requested FROM t4_session_intents WHERE session_id = ${row.target_id}`;
				if (intent[0] && (intent[0].cancellation_requested || intent[0].deletion_requested || intent[0].state === "cancelling" || intent[0].state === "cancelled")) {
					await this.#terminalizePendingSessionCommands(transaction, row.principal_id, row.target_id, "session cancelled or deleted", lease.epoch);
					return undefined;
				}
			} else if (row.mutation_kind.startsWith("workspace.")) {
				const intent = await transaction<{ revision: bigint; deletion_requested: boolean }[]>`SELECT revision, deletion_requested FROM t4_workspace_intents WHERE workspace_id = ${row.target_id}`;
				superseded = !intent[0] || intent[0].revision !== row.target_revision || row.mutation_kind === "workspace.create" && intent[0].deletion_requested;
			}
			if (superseded) {
				await transaction`UPDATE t4_outbox SET state = 'skipped', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, terminal_result = ${{ reason: "superseded intent", ownerId: lease.ownerId, ownerEpoch: lease.epoch.toString() }}, updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id}`;
				return undefined;
			}
			const claimed = await transaction<{ claimed_at: string; apply_expires_at_ms: bigint }[]>`UPDATE t4_outbox SET state = 'claimed', owner_id = ${lease.ownerId}, owner_epoch = ${lease.epoch}, attempts = attempts + 1, claimed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id} RETURNING floor(extract(epoch FROM claimed_at) * 1000000)::numeric::text AS claimed_at, floor(extract(epoch FROM LEAST(claimed_at + (${STALE_APPLY_DEADLINE_SECONDS} * interval '1 second'), (SELECT expires_at FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE}))) * 1000)::bigint AS apply_expires_at_ms`;
			return { outboxId: row.outbox_id, commandId: row.command_id, principalId: row.principal_id, idempotencyKey: row.idempotency_key, kind: row.mutation_kind, targetId: row.target_id, targetRevision: row.target_revision, mutation: row.mutation, ownerId: lease.ownerId, ownerEpoch: lease.epoch, expiresAt: safeNumber(claimed[0]!.apply_expires_at_ms), claimedAt: claimed[0]!.claimed_at };
		});
	}

	async claimIsCurrent(claim: OutboxClaim): Promise<boolean> {
		const rows = await this.#sql<{ mutation: Record<string, unknown> }[]>`SELECT item.mutation FROM t4_owner_leases lease JOIN t4_outbox item ON item.outbox_id = ${claim.outboxId} WHERE lease.lease_name = ${OUTBOX_LEASE} AND lease.owner_id = ${claim.ownerId} AND lease.epoch = ${claim.ownerEpoch} AND lease.expires_at > clock_timestamp() AND item.state = 'claimed' AND item.owner_id = lease.owner_id AND item.owner_epoch = lease.epoch AND floor(extract(epoch FROM item.claimed_at) * 1000000)::numeric::text = ${claim.claimedAt} AND item.command_id = ${claim.commandId} AND item.principal_id = ${claim.principalId} AND item.idempotency_key = ${claim.idempotencyKey} AND item.mutation_kind = ${claim.kind} AND item.target_id = ${claim.targetId} AND item.target_revision = ${claim.targetRevision} LIMIT 1`;
		return rows[0] !== undefined && semanticJsonEqual(rows[0].mutation, claim.mutation);
	}

	async acknowledge(claim: OutboxClaim): Promise<boolean> {
		return await this.#serializable(async transaction => {
			const lease = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (lease[0]?.owner_id !== claim.ownerId || lease[0].epoch !== claim.ownerEpoch || lease[0].expired) return false;
			const rows = await transaction<LockedOutboxRow[]>`SELECT outbox_id, command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation, state, owner_id, owner_epoch, floor(extract(epoch FROM claimed_at) * 1000000)::numeric::text AS claimed_at FROM t4_outbox WHERE outbox_id = ${claim.outboxId} FOR UPDATE`;
			const row = rows[0];
			if (!row || row.state !== "claimed" || row.owner_id !== claim.ownerId || row.owner_epoch !== claim.ownerEpoch || row.claimed_at !== claim.claimedAt
				|| row.command_id !== claim.commandId || row.principal_id !== claim.principalId || row.idempotency_key !== claim.idempotencyKey
				|| row.mutation_kind !== claim.kind || row.target_id !== claim.targetId || row.target_revision !== claim.targetRevision
				|| !semanticJsonEqual(row.mutation, claim.mutation)) return false;
			await transaction`UPDATE t4_outbox SET state = 'applied', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, terminal_result = ${{ applied: true, ownerId: claim.ownerId, ownerEpoch: claim.ownerEpoch.toString() }}, updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id}`;
			await transaction`UPDATE t4_stale_create_cleanups SET state = 'applied', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, last_error = NULL, updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id} AND state <> 'applied'`;
			const projected = await transaction<{ command_id: string }[]>`UPDATE t4_commands SET lifecycle_state = 'projected', updated_at = clock_timestamp() WHERE command_id = ${row.command_id} AND lifecycle_state = 'accepted' RETURNING command_id`;
			if (projected[0] && row.mutation_kind === "command.submit") await this.#appendEvent(transaction, row.principal_id, row.target_id, "command", { commandId: row.command_id, state: "projected" }, claim.ownerEpoch);
			if (row.mutation_kind === "workspace.create") await transaction`UPDATE t4_workspace_intents SET state = 'provisioning', updated_at = clock_timestamp() WHERE workspace_id = ${row.target_id} AND revision = ${row.target_revision} AND state = 'accepted' AND deletion_requested = false`;
			if (row.mutation_kind === "session.create") {
				const transitioned = await transaction<{ session_id: string }[]>`UPDATE t4_session_intents SET state = 'provisioning', updated_at = clock_timestamp() WHERE session_id = ${row.target_id} AND revision = ${row.target_revision} AND state = 'accepted' AND cancellation_requested = false RETURNING session_id`;
				if (transitioned[0]) await this.#appendEvent(transaction, row.principal_id, row.target_id, "session", { state: "provisioning", revision: safeNumber(row.target_revision) }, claim.ownerEpoch);
			}
			return true;
		});
	}

	async recordFailure(claim: OutboxClaim, message: string): Promise<boolean> {
		return await this.#serializable(async transaction => {
			const lease = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (lease[0]?.owner_id !== claim.ownerId || lease[0].epoch !== claim.ownerEpoch || lease[0].expired) return false;
			const rows = await transaction<LockedOutboxRow[]>`SELECT outbox_id, command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation, state, owner_id, owner_epoch, floor(extract(epoch FROM claimed_at) * 1000000)::numeric::text AS claimed_at FROM t4_outbox WHERE outbox_id = ${claim.outboxId} FOR UPDATE`;
			const row = rows[0];
			if (!row || row.state !== "claimed" || row.owner_id !== claim.ownerId || row.owner_epoch !== claim.ownerEpoch || row.claimed_at !== claim.claimedAt
				|| row.command_id !== claim.commandId || row.principal_id !== claim.principalId || row.idempotency_key !== claim.idempotencyKey
				|| row.mutation_kind !== claim.kind || row.target_id !== claim.targetId || row.target_revision !== claim.targetRevision
				|| !semanticJsonEqual(row.mutation, claim.mutation)) return false;
			await transaction`UPDATE t4_outbox SET state = 'pending', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, last_error = ${message.slice(0, 1024)}, next_attempt_at = clock_timestamp() + interval '1 second', updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id}`;
			return true;
		});
	}

	async ingestKubernetesStatus(lease: OwnerLease, collection: KubernetesStatusCollection, ingress: AuthoritativeKubernetesStatusIngress): Promise<void> {
		if (collection !== "t4workspaces" && collection !== "t4sessions") throw new Error("Kubernetes status collection is invalid");
		if ("relisted" in ingress) {
			if (!ingress.resourceVersion || Buffer.byteLength(ingress.resourceVersion, "utf8") > 256
				|| !Array.isArray(ingress.resourceIds) || ingress.resourceIds.some(resourceId => typeof resourceId !== "string" || !resourceId || Buffer.byteLength(resourceId, "utf8") > 256)) throw new Error("Kubernetes status relist identity is invalid");
			const present = new Set(ingress.resourceIds);
			await this.#serializable(async transaction => {
				const currentLease = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
				if (currentLease[0]?.owner_id !== lease.ownerId || currentLease[0].epoch !== lease.epoch || currentLease[0].expired) throw new Error("Kubernetes status owner lease is no longer current");
				if (collection === "t4workspaces") {
					const missing = await transaction<MissingWorkspaceStatusRow[]>`SELECT workspace_id FROM t4_workspace_intents WHERE state = 'deleting' AND deletion_requested = true FOR UPDATE`;
					for (const row of missing) {
						if (!present.has(row.workspace_id)) await transaction`UPDATE t4_workspace_intents SET state = 'deleted', updated_at = clock_timestamp() WHERE workspace_id = ${row.workspace_id} AND state = 'deleting'`;
					}
				} else {
					const missing = await transaction<MissingSessionStatusRow[]>`SELECT session_id, principal_id, revision FROM t4_session_intents WHERE state <> 'cancelled' AND (state = 'cancelling' AND cancellation_requested = true OR deletion_requested = true) FOR UPDATE`;
					for (const row of missing) {
						if (present.has(row.session_id)) continue;
						const transitioned = await transaction<{ session_id: string }[]>`UPDATE t4_session_intents SET state = 'cancelled', updated_at = clock_timestamp() WHERE session_id = ${row.session_id} AND state <> 'cancelled' RETURNING session_id`;
						if (transitioned[0]) {
							await this.#terminalizePendingSessionCommands(transaction, row.principal_id, row.session_id, "session absent from authoritative relist", lease.epoch);
							await this.#appendEvent(transaction, row.principal_id, row.session_id, "session", { state: "cancelled", revision: safeNumber(row.revision) }, lease.epoch);
						}
					}
				}
				await transaction`INSERT INTO t4_kubernetes_status_cursors (collection, resource_version, owner_epoch) VALUES (${collection}, ${ingress.resourceVersion}, ${lease.epoch}) ON CONFLICT (collection) DO UPDATE SET resource_version = EXCLUDED.resource_version, owner_epoch = EXCLUDED.owner_epoch, updated_at = clock_timestamp()`;
			});
			return;
		}
		const observation = ingress;
		if (!observation.resourceId || !observation.principalId || !observation.uid || !observation.resourceVersion || Buffer.byteLength(observation.uid, "utf8") > 256 || Buffer.byteLength(observation.resourceVersion, "utf8") > 256) throw new Error("Kubernetes status identity is incomplete or unbounded");
		if (typeof observation.generation !== "bigint" || observation.generation <= 0n || typeof observation.observedGeneration !== "bigint" || observation.observedGeneration < 0n) throw new Error("Kubernetes status generation is invalid");
		if (collection === "t4sessions" && !observation.workspaceId) throw new Error("Kubernetes session status lacks workspace identity");
		await this.#serializable(async transaction => {
			const currentLease = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (currentLease[0]?.owner_id !== lease.ownerId || currentLease[0].epoch !== lease.epoch || currentLease[0].expired) throw new Error("Kubernetes status owner lease is no longer current");
			const rows = collection === "t4workspaces"
				? await transaction<KubernetesStatusRow[]>`SELECT state, revision, generation, kube_uid, kube_resource_version, kube_generation, kube_observed_generation, deletion_requested FROM t4_workspace_intents WHERE workspace_id = ${observation.resourceId} AND principal_id = ${observation.principalId} FOR UPDATE`
				: await transaction<KubernetesStatusRow[]>`SELECT state, revision, generation, kube_uid, kube_resource_version, kube_generation, kube_observed_generation, cancellation_requested, deletion_requested FROM t4_session_intents WHERE session_id = ${observation.resourceId} AND principal_id = ${observation.principalId} AND workspace_id = ${observation.workspaceId!} FOR UPDATE`;
			const row = rows[0];
			await transaction`INSERT INTO t4_kubernetes_status_cursors (collection, resource_version, owner_epoch) VALUES (${collection}, ${observation.resourceVersion}, ${lease.epoch}) ON CONFLICT (collection) DO UPDATE SET resource_version = EXCLUDED.resource_version, owner_epoch = EXCLUDED.owner_epoch, updated_at = clock_timestamp()`;
			if (!row) return;
			if (row.kube_uid !== null && row.kube_uid !== observation.uid) throw new Error("Kubernetes status UID conflicts with the durable resource identity");
			if (row.kube_resource_version === observation.resourceVersion && !observation.deleted) return;
			if (!observation.deleted && (row.kube_generation !== null && observation.generation < row.kube_generation
				|| row.kube_generation === observation.generation && row.kube_observed_generation !== null && observation.observedGeneration < row.kube_observed_generation)) return;
			const statusIsCurrent = observation.observedGeneration >= observation.generation && observation.generation >= row.generation;
			if (collection === "t4workspaces") {
				const absorbed = row.deletion_requested || row.state === "deleting" || row.state === "deleted";
				const mapped: WorkspaceRecord["state"] = observation.phase === "Pending" ? "provisioning"
					: observation.phase === "Ready" || observation.phase === "Running" ? "ready"
						: observation.phase === "Failed" ? "failed"
							: observation.phase === "Terminating" ? "deleting" : "indeterminate";
				const nextState: WorkspaceRecord["state"] = observation.deleted ? "deleted" : statusIsCurrent && !absorbed ? mapped : row.state as WorkspaceRecord["state"];
				await transaction`UPDATE t4_workspace_intents SET kube_uid = ${observation.uid}, kube_resource_version = ${observation.resourceVersion}, kube_generation = ${observation.generation}, kube_observed_generation = ${observation.observedGeneration}, state = ${nextState}, updated_at = clock_timestamp() WHERE workspace_id = ${observation.resourceId}`;
			} else {
				const absorbed = row.cancellation_requested === true || row.deletion_requested || row.state === "cancelling" || row.state === "cancelled";
				const mapped: SessionRecord["state"] = observation.phase === "Pending" ? "provisioning"
					: observation.phase === "Ready" || observation.phase === "Running" ? "ready"
						: observation.phase === "Failed" ? "failed"
							: observation.phase === "Terminating" ? "cancelling" : "indeterminate";
				const nextState: SessionRecord["state"] = observation.deleted ? "cancelled" : statusIsCurrent && !absorbed ? mapped : row.state as SessionRecord["state"];
				await transaction`UPDATE t4_session_intents SET kube_uid = ${observation.uid}, kube_resource_version = ${observation.resourceVersion}, kube_generation = ${observation.generation}, kube_observed_generation = ${observation.observedGeneration}, state = ${nextState}, updated_at = clock_timestamp() WHERE session_id = ${observation.resourceId}`;
				if (nextState !== row.state) {
					if (nextState === "cancelled") await this.#terminalizePendingSessionCommands(transaction, observation.principalId, observation.resourceId, "session deleted in Kubernetes", lease.epoch);
					await this.#appendEvent(transaction, observation.principalId, observation.resourceId, "session", { state: nextState, revision: safeNumber(row.revision) }, lease.epoch);
				}
			}
		});
	}

	async persistStaleCreateCleanup(claim: OutboxClaim, cleanup: StaleCreateCleanup): Promise<boolean> {
		if ((cleanup.resourceType !== "t4workspaces" && cleanup.resourceType !== "t4sessions") || !cleanup.targetId || !cleanup.uid || !cleanup.resourceVersion
			|| Buffer.byteLength(cleanup.uid, "utf8") > 256 || Buffer.byteLength(cleanup.resourceVersion, "utf8") > 256) return false;
		return await this.#serializable(async transaction => {
			const rows = await transaction<LockedOutboxRow[]>`SELECT outbox_id, command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation, state, owner_id, owner_epoch, floor(extract(epoch FROM claimed_at) * 1000000)::numeric::text AS claimed_at FROM t4_outbox WHERE outbox_id = ${claim.outboxId} FOR UPDATE`;
			const row = rows[0];
			const resourceType = row?.mutation_kind === "workspace.create" ? "t4workspaces" : row?.mutation_kind === "session.create" ? "t4sessions" : undefined;
			if (!row || row.state === "applied" || resourceType !== cleanup.resourceType || row.target_id !== cleanup.targetId || row.command_id !== claim.commandId || row.principal_id !== claim.principalId
				|| row.idempotency_key !== claim.idempotencyKey || row.mutation_kind !== claim.kind || row.target_id !== claim.targetId || row.target_revision !== claim.targetRevision
				|| !semanticJsonEqual(row.mutation, claim.mutation)) return false;
			await transaction`INSERT INTO t4_stale_create_cleanups (outbox_id, resource_type, target_id, uid, resource_version) VALUES (${row.outbox_id}, ${cleanup.resourceType}, ${cleanup.targetId}, ${cleanup.uid}, ${cleanup.resourceVersion}) ON CONFLICT (outbox_id, uid) DO UPDATE SET resource_version = EXCLUDED.resource_version, state = CASE WHEN t4_stale_create_cleanups.state = 'applied' THEN 'applied' ELSE 'pending' END, owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()`;
			return true;
		});
	}

	async claimStaleCreateCleanup(lease: OwnerLease): Promise<StaleCreateCleanupClaim | undefined> {
		return await this.#serializable(async transaction => {
			const current = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (current[0]?.owner_id !== lease.ownerId || current[0].epoch !== lease.epoch || current[0].expired) return undefined;
			const rows = await transaction<CleanupRow[]>`SELECT cleanup.cleanup_id, cleanup.resource_type, cleanup.target_id, cleanup.uid, cleanup.resource_version FROM t4_stale_create_cleanups cleanup JOIN t4_outbox item ON item.outbox_id = cleanup.outbox_id WHERE item.state <> 'applied' AND (cleanup.state = 'pending' OR (cleanup.state = 'claimed' AND cleanup.owner_epoch < ${lease.epoch}) OR (cleanup.state = 'claimed' AND cleanup.owner_id = ${lease.ownerId} AND cleanup.owner_epoch = ${lease.epoch} AND cleanup.claimed_at <= clock_timestamp() - (${STALE_APPLY_DEADLINE_SECONDS} * interval '1 second'))) AND cleanup.next_attempt_at <= clock_timestamp() ORDER BY cleanup.cleanup_id FOR UPDATE OF cleanup SKIP LOCKED LIMIT 1`;
			const row = rows[0];
			if (!row) return undefined;
			const claimed = await transaction<{ claimed_at: string; apply_expires_at_ms: bigint }[]>`UPDATE t4_stale_create_cleanups SET state = 'claimed', owner_id = ${lease.ownerId}, owner_epoch = ${lease.epoch}, attempts = attempts + 1, claimed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE cleanup_id = ${row.cleanup_id} RETURNING floor(extract(epoch FROM claimed_at) * 1000000)::numeric::text AS claimed_at, floor(extract(epoch FROM LEAST(claimed_at + (${STALE_APPLY_DEADLINE_SECONDS} * interval '1 second'), (SELECT expires_at FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE}))) * 1000)::bigint AS apply_expires_at_ms`;
			return { cleanupId: row.cleanup_id, resourceType: row.resource_type, targetId: row.target_id, uid: row.uid, resourceVersion: row.resource_version, ownerId: lease.ownerId, ownerEpoch: lease.epoch, expiresAt: safeNumber(claimed[0]!.apply_expires_at_ms), claimedAt: claimed[0]!.claimed_at };
		});
	}

	async staleCreateCleanupClaimIsCurrent(claim: StaleCreateCleanupClaim): Promise<boolean> {
		const rows = await this.#sql<{ valid: boolean }[]>`SELECT EXISTS (SELECT 1 FROM t4_owner_leases lease JOIN t4_stale_create_cleanups cleanup ON cleanup.cleanup_id = ${claim.cleanupId} JOIN t4_outbox item ON item.outbox_id = cleanup.outbox_id WHERE lease.lease_name = ${OUTBOX_LEASE} AND lease.owner_id = ${claim.ownerId} AND lease.epoch = ${claim.ownerEpoch} AND lease.expires_at > clock_timestamp() AND item.state <> 'applied' AND cleanup.state = 'claimed' AND cleanup.owner_id = lease.owner_id AND cleanup.owner_epoch = lease.epoch AND floor(extract(epoch FROM cleanup.claimed_at) * 1000000)::numeric::text = ${claim.claimedAt} AND cleanup.resource_type = ${claim.resourceType} AND cleanup.target_id = ${claim.targetId} AND cleanup.uid = ${claim.uid} AND cleanup.resource_version = ${claim.resourceVersion}) AS valid`;
		return rows[0]?.valid === true;
	}

	async acknowledgeStaleCreateCleanup(claim: StaleCreateCleanupClaim): Promise<boolean> {
		return await this.#finishStaleCreateCleanup(claim, undefined);
	}

	async recordStaleCreateCleanupFailure(claim: StaleCreateCleanupClaim, message: string): Promise<boolean> {
		return await this.#finishStaleCreateCleanup(claim, message.slice(0, 1024));
	}

	async #finishStaleCreateCleanup(claim: StaleCreateCleanupClaim, failure: string | undefined): Promise<boolean> {
		return await this.#serializable(async transaction => {
			const lease = await transaction<LeaseRow[]>`SELECT owner_id, epoch, expires_at <= clock_timestamp() AS expired FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (lease[0]?.owner_id !== claim.ownerId || lease[0].epoch !== claim.ownerEpoch || lease[0].expired) return false;
			const rows = await transaction<{ cleanup_id: bigint }[]>`SELECT cleanup_id FROM t4_stale_create_cleanups WHERE cleanup_id = ${claim.cleanupId} AND state = 'claimed' AND owner_id = ${claim.ownerId} AND owner_epoch = ${claim.ownerEpoch} AND floor(extract(epoch FROM claimed_at) * 1000000)::numeric::text = ${claim.claimedAt} AND resource_type = ${claim.resourceType} AND target_id = ${claim.targetId} AND uid = ${claim.uid} AND resource_version = ${claim.resourceVersion} FOR UPDATE`;
			if (!rows[0]) return false;
			if (failure === undefined) await transaction`UPDATE t4_stale_create_cleanups SET state = 'applied', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, last_error = NULL, updated_at = clock_timestamp() WHERE cleanup_id = ${claim.cleanupId}`;
			else await transaction`UPDATE t4_stale_create_cleanups SET state = 'pending', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, last_error = ${failure}, next_attempt_at = clock_timestamp() + interval '1 second', updated_at = clock_timestamp() WHERE cleanup_id = ${claim.cleanupId}`;
			return true;
		});
	}

	async #terminalizePendingSessionCommands(transaction: SQL, principalId: string, sessionId: string, reason: string, ownerEpoch: bigint): Promise<void> {
		const skipped = await transaction<{ command_id: string }[]>`UPDATE t4_outbox SET state = 'skipped', owner_id = NULL, owner_epoch = NULL, claimed_at = NULL, terminal_result = ${{ reason }}, updated_at = clock_timestamp() WHERE principal_id = ${principalId} AND target_id = ${sessionId} AND mutation_kind = 'command.submit' AND state IN ('pending','claimed') RETURNING command_id`;
		for (const row of skipped) {
			const terminal = await transaction<{ command_id: string }[]>`UPDATE t4_commands SET lifecycle_state = 'cancelled', updated_at = clock_timestamp() WHERE command_id = ${row.command_id} AND lifecycle_state = 'accepted' RETURNING command_id`;
			if (terminal[0]) await this.#appendEvent(transaction, principalId, sessionId, "command", { commandId: row.command_id, state: "cancelled" }, ownerEpoch);
		}
	}

	async #serializable<T>(operation: (transaction: SQL) => Promise<T>): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => await operation(transaction as unknown as SQL));
			} catch (error) {
				const code = postgresSqlState(error);
				const retryable = code === "40001" || code === "40P01" || isIdempotencyUniqueRace(error);
				if (attempt >= SERIALIZABLE_ATTEMPTS || !retryable) throw error;
			}
		}
	}

	async #lockIdempotency(transaction: SQL, principalId: string, operation: string, scope: string, idempotencyKey: string): Promise<void> {
		const identity = stableJson([principalId, operation, scope, idempotencyKey]);
		await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
	}

	#cursor(kind: "watch" | "page", principalId: string, scope: string, position: bigint | string): string {
		const payload = Buffer.from(JSON.stringify({ k: kind, p: createHash("sha256").update(principalId).digest("base64url"), s: scope, q: position.toString() }), "utf8").toString("base64url");
		const signature = createHmac("sha256", this.#cursorSecret).update(payload).digest("base64url");
		return `${payload}.${signature}`;
	}
	#decodeCursor(cursor: string, kind: "watch" | "page", principalId: string, scope: string): bigint | string | undefined {
		if (cursor.length > 512 || !/^[A-Za-z0-9._~-]+$/u.test(cursor)) return undefined;
		const [payload, signature, extra] = cursor.split(".");
		if (!payload || !signature || extra) return undefined;
		const expected = createHmac("sha256", this.#cursorSecret).update(payload).digest();
		let supplied: Buffer;
		try { supplied = Buffer.from(signature, "base64url"); } catch { return undefined; }
		if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return undefined;
		let value: { k?: unknown; p?: unknown; s?: unknown; q?: unknown };
		try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof value; } catch { return undefined; }
		if (value.k !== kind || value.p !== createHash("sha256").update(principalId).digest("base64url") || value.s !== scope || typeof value.q !== "string") return undefined;
		if (kind === "page") return value.q;
		if (!/^(?:0|[1-9][0-9]*)$/u.test(value.q)) return undefined;
		return BigInt(value.q);
	}

	async #appendEvent(transaction: SQL, principalId: string, sessionId: string, type: "session" | "command", payload: Record<string, unknown>, ownerEpoch: bigint): Promise<bigint> {
		const inserted = await transaction<{ sequence: bigint }[]>`INSERT INTO t4_events (principal_id, session_id, event_type, payload, owner_epoch) VALUES (${principalId}, ${sessionId}, ${type}, ${payload}, ${ownerEpoch}) RETURNING sequence`;
		const sequence = persistedBigint(inserted[0]?.sequence);
		await transaction`DELETE FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND sequence < COALESCE((SELECT sequence FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId} ORDER BY sequence DESC OFFSET ${this.#eventRetention - 1} LIMIT 1), 0)`;
		const retained = await transaction<{ first: bigint; latest: bigint }[]>`SELECT COALESCE(MIN(sequence), 0) AS first, COALESCE(MAX(sequence), 0) AS latest FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
		const first = persistedBigint(retained[0]?.first, true);
		const latest = persistedBigint(retained[0]?.latest, true);
		await transaction`INSERT INTO t4_event_retention (principal_id, session_id, first_retained_sequence, latest_sequence) VALUES (${principalId}, ${sessionId}, ${first}, ${latest}) ON CONFLICT (principal_id, session_id) DO UPDATE SET first_retained_sequence = EXCLUDED.first_retained_sequence, latest_sequence = EXCLUDED.latest_sequence, updated_at = clock_timestamp()`;
		return sequence;
	}
}
