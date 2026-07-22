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
}
export interface OwnerLease {
	readonly ownerId: string;
	readonly epoch: bigint;
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
}
interface EventRow {
	readonly sequence: bigint;
	readonly event_type: "session" | "command";
	readonly payload: Record<string, unknown>;
}
interface RetentionRow { readonly first_retained_sequence: bigint; readonly latest_sequence: bigint; }
interface LeaseRow { readonly owner_id: string; readonly epoch: bigint; }
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

const MIGRATION_URL = new URL("../migrations/001_durable_gateway.sql", import.meta.url);
const ROLLBACK_URL = new URL("../migrations/001_durable_gateway.down.sql", import.meta.url);
const OUTBOX_LEASE = "gateway-outbox";
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function safeNumber(value: bigint): number {
	if (value < 0n || value > MAX_SAFE_BIGINT) throw new Error("persisted ledger integer is outside the public API range");
	return Number(value);
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
		await this.#sql.unsafe(migration);
		const rows = await this.#sql<{ version: number }[]>`SELECT version FROM t4_schema_migrations ORDER BY version DESC LIMIT 1`;
		if (rows[0]?.version !== 1) throw new Error("durable gateway schema migration did not reach version 1");
	}
	async rollback(): Promise<void> {
		await this.#sql.unsafe(await Bun.file(ROLLBACK_URL).text());
	}
	async close(): Promise<void> { await this.#sql.close(); }

	async createWorkspace(principalId: string, idempotencyKey: string, fingerprint: string, input: { name: string; labels?: Record<string, string> }): Promise<LedgerMutationResult<WorkspaceRecord>> {
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
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
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const rows = await transaction<WorkspaceRow[]>`SELECT workspace_id, name, state, revision, labels FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND state <> 'deleted' FOR UPDATE`;
			const current = rows[0];
			if (!current) return { kind: "not_found" };
			if (current.revision !== BigInt(expectedRevision)) return { kind: "revision_conflict" };
			const scope = `workspace:${workspaceId}`;
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'mutateWorkspace' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as WorkspaceRecord } : { kind: "idempotency_conflict" };
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
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const scope = `workspace:${workspaceId}`;
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
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const workspaceRows = await transaction<{ workspace_id: string }[]>`SELECT workspace_id FROM t4_workspace_intents WHERE principal_id = ${principalId} AND workspace_id = ${workspaceId} AND state NOT IN ('deleting','deleted') FOR UPDATE`;
			if (!workspaceRows[0]) return { kind: "not_found" };
			const scope = `workspace:${workspaceId}:sessions`;
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'spawnSession' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as SessionRecord } : { kind: "idempotency_conflict" };
			const commandId = `cmd_${randomUUID()}`;
			const sessionId = `ss-${randomUUID()}`;
			const value: SessionRecord = { id: sessionId, workspaceId, title: input.title, state: "accepted", revision: 1, ...(input.labels ? { labels: input.labels } : {}) };
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'spawnSession', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 202, ${value})`;
			await transaction`INSERT INTO t4_session_intents (session_id, workspace_id, principal_id, title, labels, state, revision, generation) VALUES (${sessionId}, ${workspaceId}, ${principalId}, ${input.title}, ${input.labels ?? {}}, 'accepted', 1, 1)`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'session.create', ${sessionId}, 1, ${value})`;
			await this.#appendEvent(transaction as unknown as SQL, principalId, sessionId, "session", { state: "accepted", revision: 1 }, 0n);
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
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const rows = await transaction<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId} FOR UPDATE`;
			const current = rows[0];
			if (!current) return { kind: "not_found" };
			if (current.revision !== BigInt(expectedRevision)) return { kind: "revision_conflict" };
			const scope = `session:${sessionId}`;
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'mutateSession' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as SessionRecord } : { kind: "idempotency_conflict" };
			const revision = current.revision + 1n;
			const value: SessionRecord = { id: sessionId, workspaceId: current.workspace_id, title: input.title ?? current.title, state: current.state, revision: safeNumber(revision), ...(input.labels ?? labels(current.labels) ? { labels: input.labels ?? current.labels } : {}) };
			const commandId = `cmd_${randomUUID()}`;
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'mutateSession', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 200, ${value})`;
			await transaction`UPDATE t4_session_intents SET title = ${value.title}, labels = ${value.labels ?? {}}, revision = ${revision}, generation = generation + 1, updated_at = clock_timestamp() WHERE session_id = ${sessionId}`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, 'session.patch', ${sessionId}, ${revision}, ${value})`;
			await this.#appendEvent(transaction as unknown as SQL, principalId, sessionId, "session", { state: value.state, revision: value.revision }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async cancelSession(principalId: string, sessionId: string, idempotencyKey: string, fingerprint: string, deletion = false): Promise<LedgerMutationResult<SessionRecord>> {
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const operation = deletion ? "deleteSession" : "cancelSession";
			const scope = `session:${sessionId}`;
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = ${operation} AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as SessionRecord } : { kind: "idempotency_conflict" };
			const rows = await transaction<SessionRow[]>`SELECT session_id, workspace_id, title, state, revision, labels, cancellation_requested FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId} FOR UPDATE`;
			const current = rows[0];
			if (!current) return { kind: "not_found" };
			const revision = current.revision + 1n;
			const value: SessionRecord = { id: sessionId, workspaceId: current.workspace_id, title: current.title, state: "cancelling", revision: safeNumber(revision), ...(labels(current.labels) ? { labels: current.labels } : {}) };
			const commandId = `cmd_${randomUUID()}`;
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, ${operation}, ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', ${deletion ? 204 : 202}, ${value})`;
			await transaction`UPDATE t4_session_intents SET state = 'cancelling', cancellation_requested = true, deletion_requested = deletion_requested OR ${deletion}, revision = ${revision}, generation = generation + 1, updated_at = clock_timestamp() WHERE session_id = ${sessionId}`;
			await transaction`UPDATE t4_outbox SET state = 'skipped', terminal_result = ${{ reason: "superseded by cancellation" }}, updated_at = clock_timestamp() WHERE target_id = ${sessionId} AND mutation_kind = 'session.create' AND state IN ('pending','claimed')`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) VALUES (${commandId}, ${principalId}, ${idempotencyKey}, ${deletion ? "session.delete" : "session.cancel"}, ${sessionId}, ${revision}, ${{ sessionId, revision: safeNumber(revision) }})`;
			await this.#appendEvent(transaction as unknown as SQL, principalId, sessionId, "session", { state: "cancelling", revision: safeNumber(revision) }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async submitCommand(principalId: string, sessionId: string, idempotencyKey: string, fingerprint: string, input: { command: string; metadata: Record<string, string | number | boolean | null> }): Promise<LedgerMutationResult<{ commandId: string; state: "accepted" }>> {
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const sessionRows = await transaction<{ session_id: string }[]>`SELECT session_id FROM t4_session_intents WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND state NOT IN ('cancelling','cancelled') FOR UPDATE`;
			if (!sessionRows[0]) return { kind: "not_found" };
			const scope = `session:${sessionId}:commands`;
			const prior = await transaction<CommandRow[]>`SELECT fingerprint, response_body FROM t4_commands WHERE principal_id = ${principalId} AND operation = 'submitCommand' AND target_scope = ${scope} AND idempotency_key = ${idempotencyKey} FOR UPDATE`;
			if (prior[0]) return prior[0].fingerprint === fingerprint ? { kind: "replay", value: prior[0].response_body as { commandId: string; state: "accepted" } } : { kind: "idempotency_conflict" };
			const commandId = `cmd_${randomUUID()}`;
			const value = { commandId, state: "accepted" as const };
			await transaction`INSERT INTO t4_commands (command_id, principal_id, operation, target_scope, idempotency_key, fingerprint, lifecycle_state, response_status, response_body) VALUES (${commandId}, ${principalId}, 'submitCommand', ${scope}, ${idempotencyKey}, ${fingerprint}, 'accepted', 202, ${value})`;
			await transaction`INSERT INTO t4_outbox (command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation) SELECT ${commandId}, ${principalId}, ${idempotencyKey}, 'command.submit', ${sessionId}, revision, ${{ sessionId, ...input }} FROM t4_session_intents WHERE session_id = ${sessionId}`;
			const entryRows = await transaction<{ next: bigint }[]>`SELECT COALESCE(MAX(entry_sequence), -1) + 1 AS next FROM t4_snapshot_entries WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
			await transaction`INSERT INTO t4_snapshot_entries (principal_id, session_id, entry_sequence, kind, text_value) VALUES (${principalId}, ${sessionId}, ${entryRows[0]?.next ?? 0n}, 'input', ${input.command})`;
			await this.#appendEvent(transaction as unknown as SQL, principalId, sessionId, "command", { commandId, state: "accepted" }, 0n);
			return { kind: "accepted", commandId, value };
		});
	}

	async snapshot(principalId: string, sessionId: string): Promise<{ session: SessionRecord; cursor: string; entries: readonly { sequence: number; kind: "input" | "output" | "status"; text: string }[] } | undefined> {
		const current = await this.getSession(principalId, sessionId);
		if (!current) return undefined;
		const rows = await this.#sql<{ entry_sequence: bigint; kind: "input" | "output" | "status"; text_value: string }[]>`SELECT entry_sequence, kind, text_value FROM t4_snapshot_entries WHERE principal_id = ${principalId} AND session_id = ${sessionId} ORDER BY entry_sequence DESC LIMIT 1000`;
		const retention = await this.#sql<RetentionRow[]>`SELECT first_retained_sequence, latest_sequence FROM t4_event_retention WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
		const latest = retention[0]?.latest_sequence ?? 0n;
		return { session: current, cursor: this.watchCursor(principalId, sessionId, latest), entries: rows.reverse().map(row => ({ sequence: safeNumber(row.entry_sequence), kind: row.kind, text: row.text_value })) };
	}

	async eventWindow(principalId: string, sessionId: string, cursor: string | undefined, limit: number): Promise<EventWindow | undefined> {
		if (!await this.getSession(principalId, sessionId)) return undefined;
		const retentionRows = await this.#sql<RetentionRow[]>`SELECT first_retained_sequence, latest_sequence FROM t4_event_retention WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
		const first = retentionRows[0]?.first_retained_sequence ?? 0n;
		const latest = retentionRows[0]?.latest_sequence ?? 0n;
		let after = 0n;
		if (cursor) {
			const decoded = this.#decodeCursor(cursor, "watch", principalId, sessionId);
			if (decoded === undefined) throw new Error("invalid_cursor");
			after = decoded;
		}
		const resyncCursor = this.watchCursor(principalId, sessionId, latest);
		if (first > 0n && after < first - 1n) return { events: [], cursor: resyncCursor, expired: true, resyncCursor };
		const rows = await this.#sql<EventRow[]>`SELECT sequence, event_type, payload FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND sequence > ${after} ORDER BY sequence LIMIT ${limit}`;
		const delivered = rows.at(-1)?.sequence ?? after;
		return { events: rows.map(row => ({ sequence: row.sequence, type: row.event_type, payload: row.payload })), cursor: this.watchCursor(principalId, sessionId, delivered), expired: false, resyncCursor };
	}

	watchCursor(principalId: string, sessionId: string, sequence: bigint): string { return this.#cursor("watch", principalId, sessionId, sequence); }
	pageCursor(principalId: string, scope: string, id: string): string { return this.#cursor("page", principalId, scope, id); }
	readPageCursor(cursor: string, principalId: string, scope: string): string | undefined {
		const result = this.#decodeCursor(cursor, "page", principalId, scope);
		return typeof result === "string" ? result : undefined;
	}

	async acquireLease(ownerId: string, leaseSeconds = 30): Promise<OwnerLease> {
		const rows = await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			await transaction`INSERT INTO t4_owner_leases (lease_name, owner_id, epoch, expires_at) VALUES (${OUTBOX_LEASE}, ${ownerId}, 1, clock_timestamp() + (${leaseSeconds} * interval '1 second')) ON CONFLICT (lease_name) DO UPDATE SET owner_id = EXCLUDED.owner_id, epoch = t4_owner_leases.epoch + 1, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()`;
			return await transaction<LeaseRow[]>`SELECT owner_id, epoch FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE}`;
		});
		return { ownerId: rows[0]!.owner_id, epoch: rows[0]!.epoch };
	}

	async claimNext(lease: OwnerLease): Promise<OutboxClaim | undefined> {
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const current = await transaction<LeaseRow[]>`SELECT owner_id, epoch FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (current[0]?.owner_id !== lease.ownerId || current[0].epoch !== lease.epoch) return undefined;
			const rows = await transaction<OutboxRow[]>`SELECT outbox_id, command_id, principal_id, idempotency_key, mutation_kind, target_id, target_revision, mutation FROM t4_outbox WHERE (state = 'pending' OR (state = 'claimed' AND owner_epoch < ${lease.epoch})) AND next_attempt_at <= clock_timestamp() ORDER BY outbox_id FOR UPDATE SKIP LOCKED LIMIT 1`;
			const row = rows[0];
			if (!row) return undefined;
			let superseded = false;
			if (row.mutation_kind.startsWith("session.")) {
				const intent = await transaction<{ revision: bigint; cancellation_requested: boolean }[]>`SELECT revision, cancellation_requested FROM t4_session_intents WHERE session_id = ${row.target_id}`;
				superseded = !intent[0] || intent[0].revision !== row.target_revision || row.mutation_kind === "session.create" && intent[0].cancellation_requested;
			} else if (row.mutation_kind.startsWith("workspace.")) {
				const intent = await transaction<{ revision: bigint; deletion_requested: boolean }[]>`SELECT revision, deletion_requested FROM t4_workspace_intents WHERE workspace_id = ${row.target_id}`;
				superseded = !intent[0] || intent[0].revision !== row.target_revision || row.mutation_kind === "workspace.create" && intent[0].deletion_requested;
			}
			if (superseded) {
				await transaction`UPDATE t4_outbox SET state = 'skipped', owner_id = ${lease.ownerId}, owner_epoch = ${lease.epoch}, terminal_result = ${{ reason: "superseded intent" }}, updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id}`;
				return undefined;
			}
			await transaction`UPDATE t4_outbox SET state = 'claimed', owner_id = ${lease.ownerId}, owner_epoch = ${lease.epoch}, attempts = attempts + 1, claimed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE outbox_id = ${row.outbox_id}`;
			return { outboxId: row.outbox_id, commandId: row.command_id, principalId: row.principal_id, idempotencyKey: row.idempotency_key, kind: row.mutation_kind, targetId: row.target_id, targetRevision: row.target_revision, mutation: row.mutation, ownerId: lease.ownerId, ownerEpoch: lease.epoch };
		});
	}

	async claimIsCurrent(claim: OutboxClaim): Promise<boolean> {
		const rows = await this.#sql<{ valid: boolean }[]>`SELECT EXISTS (SELECT 1 FROM t4_owner_leases lease JOIN t4_outbox item ON item.outbox_id = ${claim.outboxId} WHERE lease.lease_name = ${OUTBOX_LEASE} AND lease.owner_id = ${claim.ownerId} AND lease.epoch = ${claim.ownerEpoch} AND lease.expires_at > clock_timestamp() AND item.state = 'claimed' AND item.owner_id = lease.owner_id AND item.owner_epoch = lease.epoch) AS valid`;
		return rows[0]?.valid === true;
	}

	async acknowledge(claim: OutboxClaim): Promise<boolean> {
		return await this.#sql.begin("ISOLATION LEVEL SERIALIZABLE", async transaction => {
			const lease = await transaction<LeaseRow[]>`SELECT owner_id, epoch FROM t4_owner_leases WHERE lease_name = ${OUTBOX_LEASE} FOR UPDATE`;
			if (lease[0]?.owner_id !== claim.ownerId || lease[0].epoch !== claim.ownerEpoch) return false;
			const updated = await transaction<{ outbox_id: bigint }[]>`UPDATE t4_outbox SET state = 'applied', terminal_result = ${{ applied: true }}, updated_at = clock_timestamp() WHERE outbox_id = ${claim.outboxId} AND state = 'claimed' AND owner_id = ${claim.ownerId} AND owner_epoch = ${claim.ownerEpoch} RETURNING outbox_id`;
			if (!updated[0]) return false;
			await transaction`UPDATE t4_commands SET lifecycle_state = 'completed', updated_at = clock_timestamp() WHERE command_id = ${claim.commandId}`;
			if (claim.kind === "workspace.create") await transaction`UPDATE t4_workspace_intents SET state = 'provisioning', updated_at = clock_timestamp() WHERE workspace_id = ${claim.targetId} AND revision = ${claim.targetRevision}`;
			if (claim.kind === "session.create") {
				await transaction`UPDATE t4_session_intents SET state = 'provisioning', updated_at = clock_timestamp() WHERE session_id = ${claim.targetId} AND revision = ${claim.targetRevision}`;
				await this.#appendEvent(transaction as unknown as SQL, claim.principalId, claim.targetId, "session", { state: "provisioning", revision: safeNumber(claim.targetRevision) }, claim.ownerEpoch);
			}
			return true;
		});
	}

	async recordFailure(claim: OutboxClaim, message: string): Promise<boolean> {
		const result = await this.#sql<{ outbox_id: bigint }[]>`UPDATE t4_outbox item SET state = 'pending', owner_id = NULL, owner_epoch = NULL, last_error = ${message.slice(0, 1024)}, next_attempt_at = clock_timestamp() + interval '1 second', updated_at = clock_timestamp() FROM t4_owner_leases lease WHERE item.outbox_id = ${claim.outboxId} AND item.state = 'claimed' AND item.owner_id = ${claim.ownerId} AND item.owner_epoch = ${claim.ownerEpoch} AND lease.lease_name = ${OUTBOX_LEASE} AND lease.owner_id = ${claim.ownerId} AND lease.epoch = ${claim.ownerEpoch} RETURNING item.outbox_id`;
		return result.length === 1;
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
		const sequence = inserted[0]!.sequence;
		await transaction`DELETE FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId} AND sequence < COALESCE((SELECT sequence FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId} ORDER BY sequence DESC OFFSET ${this.#eventRetention - 1} LIMIT 1), 0)`;
		const retained = await transaction<{ first: bigint; latest: bigint }[]>`SELECT COALESCE(MIN(sequence), 0) AS first, COALESCE(MAX(sequence), 0) AS latest FROM t4_events WHERE principal_id = ${principalId} AND session_id = ${sessionId}`;
		await transaction`INSERT INTO t4_event_retention (principal_id, session_id, first_retained_sequence, latest_sequence) VALUES (${principalId}, ${sessionId}, ${retained[0]!.first}, ${retained[0]!.latest}) ON CONFLICT (principal_id, session_id) DO UPDATE SET first_retained_sequence = EXCLUDED.first_retained_sequence, latest_sequence = EXCLUDED.latest_sequence, updated_at = clock_timestamp()`;
		return sequence;
	}
}
