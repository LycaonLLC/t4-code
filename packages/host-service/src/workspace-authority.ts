import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const WORKSPACE_SCHEMA_VERSION = 2;

export const workspaceOwnerships = ["managed", "imported-user", "detected-external", "repository-root"] as const;
export type WorkspaceOwnership = (typeof workspaceOwnerships)[number];

export const workspaceLifecycleStates = ["creating", "active", "archiving", "archived", "recovery-required"] as const;
export type WorkspaceLifecycleState = (typeof workspaceLifecycleStates)[number];

export const workspaceErrorCodes = [
	"invalid-path",
	"path-symlink",
	"path-reused",
	"duplicate-path",
	"repository-mismatch",
	"worktree-not-found",
	"worktree-metadata-invalid",
	"identity-stale",
	"ownership-protected",
	"repository-root-protected",
	"worktree-dirty",
	"branch-unexpected",
	"head-unexpected",
	"head-rewrite",
	"branch-invalid",
	"mutation-in-progress",
	"create-failed",
	"archive-failed",
	"recovery-required",
	"unsupported-schema",
] as const;
export type WorkspaceAuthorityErrorCode = (typeof workspaceErrorCodes)[number];

export class WorkspaceAuthorityError extends Error {
	constructor(
		readonly code: WorkspaceAuthorityErrorCode,
		message: string,
		readonly diagnostic?: string,
	) {
		super(message);
		this.name = "WorkspaceAuthorityError";
	}
}

export interface WorkspaceIdentity {
	readonly repositoryId: string;
	readonly canonicalPath: string;
	readonly instanceId: string;
	readonly ownership: WorkspaceOwnership;
	readonly branch: string;
	readonly sourceCommit: string;
	readonly expectedHead: string;
}

export interface WorkspaceRecord extends WorkspaceIdentity {
	readonly repositoryRoot: string;
	readonly lifecycle: WorkspaceLifecycleState;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly archivedAt?: number;
	readonly recoveryDiagnostic?: string;
}

export interface GitProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The narrow process boundary used for every Git mutation and inspection. */
export interface WorkspaceProcessRunner {
	run(command: string, arguments_: readonly string[]): Promise<GitProcessResult>;
}

export interface WorkspaceFilesystem {
	lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean } | undefined>;
	realpath(path: string): Promise<string>;
}

export interface WorkspaceAuthorityClock {
	now(): number;
}

export interface WorkspaceAuthorityIds {
	instanceId(): string;
	leaseId(): string;
}

export interface WorkspaceAuthorityOptions {
	readonly databasePath: string;
	readonly process?: WorkspaceProcessRunner;
	readonly filesystem?: WorkspaceFilesystem;
	readonly clock?: WorkspaceAuthorityClock;
	readonly ids?: WorkspaceAuthorityIds;
}

export interface CreateWorkspaceRequest {
	readonly repositoryId: string;
	readonly repositoryPath: string;
	readonly targetPath: string;
	readonly branch: string;
	readonly sourceCommit: string;
}

export interface ImportWorkspaceRequest {
	readonly repositoryId: string;
	readonly repositoryPath: string;
	readonly workspacePath: string;
	readonly ownership?: "imported-user" | "detected-external" | "repository-root";
}

export interface ArchiveWorkspaceRequest {
	readonly instanceId: string;
}

export interface SealWorkspaceRequest {
	readonly instanceId: string;
}

interface GitWorktreeMetadata {
	readonly path: string;
	readonly head: string;
	readonly branch?: string;
	readonly detached: boolean;
}

const realClock: WorkspaceAuthorityClock = { now: () => Date.now() };
const realIds: WorkspaceAuthorityIds = { instanceId: randomUUID, leaseId: randomUUID };
const realFilesystem: WorkspaceFilesystem = {
	async lstat(path) {
		try {
			return await lstat(path);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	},
	realpath,
};
const realProcess: WorkspaceProcessRunner = {
	async run(command, arguments_) {
		const child = Bun.spawn([command, ...arguments_], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	},
};

function error(code: WorkspaceAuthorityErrorCode, message: string, diagnostic?: string): WorkspaceAuthorityError {
	return new WorkspaceAuthorityError(code, message, diagnostic);
}

function assertNoSymlinkSync(path: string, message: string): void {
	for (let cursor = path; ; cursor = dirname(cursor)) {
		if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw error("path-symlink", message);
		if (cursor === dirname(cursor)) return;
	}
}

function asText(value: unknown, name: string): string {
	if (typeof value !== "string" || !value)
		throw error("worktree-metadata-invalid", `persisted workspace ${name} is invalid`);
	return value;
}

function asNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw error("worktree-metadata-invalid", `persisted workspace ${name} is invalid`);
	return value;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
	if (typeof value !== "string" || !values.includes(value as T[number]))
		throw error("worktree-metadata-invalid", `persisted workspace ${name} is invalid`);
	return value as T[number];
}

function parseWorktreeList(output: string): GitWorktreeMetadata[] {
	const worktrees: GitWorktreeMetadata[] = [];
	for (const block of output.trim().split("\n\n")) {
		if (!block.trim()) continue;
		const fields = new Map<string, string>();
		let detached = false;
		for (const line of block.split("\n")) {
			const separator = line.indexOf(" ");
			if (separator < 0) {
				if (line === "detached") detached = true;
				continue;
			}
			fields.set(line.slice(0, separator), line.slice(separator + 1));
		}
		const path = fields.get("worktree");
		const head = fields.get("HEAD");
		if (!path || !head) throw error("worktree-metadata-invalid", "Git returned malformed worktree metadata", output);
		const ref = fields.get("branch");
		worktrees.push({
			path,
			head,
			branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined,
			detached,
		});
	}
	return worktrees;
}

/**
 * Host-owned registry for Git worktrees. The registry owns identity and deletion
 * decisions; callers only provide explicit repository and target paths.
 */
export class WorkspaceAuthority {
	readonly #database: Database;
	readonly #process: WorkspaceProcessRunner;
	readonly #filesystem: WorkspaceFilesystem;
	readonly #clock: WorkspaceAuthorityClock;
	readonly #ids: WorkspaceAuthorityIds;
	#initialized = false;

	constructor(options: WorkspaceAuthorityOptions) {
		if (!isAbsolute(options.databasePath)) throw error("invalid-path", "Workspace database path must be absolute");
		const databaseParent = dirname(options.databasePath);
		assertNoSymlinkSync(databaseParent, "Workspace database path cannot traverse a symlink");
		mkdirSync(databaseParent, { recursive: true, mode: 0o700 });
		assertNoSymlinkSync(options.databasePath, "Workspace database path cannot traverse a symlink");
		this.#process = options.process ?? realProcess;
		this.#filesystem = options.filesystem ?? realFilesystem;
		this.#clock = options.clock ?? realClock;
		this.#ids = options.ids ?? realIds;
		this.#database = new Database(options.databasePath, { create: true });
		chmodSync(options.databasePath, 0o600);
		this.#database.run("PRAGMA busy_timeout = 5000");
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#migrate();
	}

	static async open(options: WorkspaceAuthorityOptions): Promise<WorkspaceAuthority> {
		const authority = new WorkspaceAuthority(options);
		await authority.initialize();
		return authority;
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		// The appserver owner lock guarantees one authority per profile. Any durable
		// lease present before initialization therefore belongs to a crashed owner.
		this.#database.run("DELETE FROM repository_leases");
		await this.recover();
		this.#initialized = true;
	}

	close(): void {
		this.#database.close();
	}

	list(): WorkspaceRecord[] {
		return this.#database
			.query("SELECT * FROM workspaces ORDER BY created_at ASC")
			.all()
			.map(value => this.#read(value));
	}

	get(instanceId: string): WorkspaceRecord | null {
		const value = this.#database.query("SELECT * FROM workspaces WHERE instance_id=?").get(instanceId);
		return value == null ? null : this.#read(value);
	}

	resolve(instanceIdOrPath: string): WorkspaceRecord | null {
		const byId = this.get(instanceIdOrPath);
		if (byId) return byId;
		const value = this.#database.query("SELECT * FROM workspaces WHERE canonical_path=?").get(instanceIdOrPath);
		return value == null ? null : this.#read(value);
	}

	async create(request: CreateWorkspaceRequest): Promise<WorkspaceRecord> {
		this.#requireInitialized();
		return this.#withLease(request.repositoryId, async () => {
			const repositoryRoot = await this.#canonicalExistingDirectory(request.repositoryPath, "repository");
			await this.#assertRepositoryId(request.repositoryId, repositoryRoot);
			this.#bindRepository(request.repositoryId, repositoryRoot);
			const targetPath = await this.#canonicalNewPath(request.targetPath);
			this.#assertPathUnused(targetPath);
			await this.#validateBranch(repositoryRoot, request.branch);
			const sourceCommit = await this.#resolveCommit(repositoryRoot, request.sourceCommit);
			const now = this.#now();
			const record: WorkspaceRecord = {
				repositoryId: request.repositoryId,
				repositoryRoot,
				canonicalPath: targetPath,
				instanceId: this.#ids.instanceId(),
				ownership: "managed",
				branch: request.branch,
				sourceCommit,
				expectedHead: sourceCommit,
				lifecycle: "creating",
				createdAt: now,
				updatedAt: now,
			};
			this.#insert(record);
			const result = await this.#git(repositoryRoot, [
				"worktree",
				"add",
				"-b",
				request.branch,
				targetPath,
				sourceCommit,
			]);
			if (result.exitCode !== 0) {
				this.#setLifecycle(
					record.instanceId,
					"recovery-required",
					result.stderr || result.stdout || "git worktree add failed",
				);
				throw error("create-failed", "Git failed to create managed workspace", result.stderr || result.stdout);
			}
			try {
				await this.#verifyIdentity(record, true);
				this.#setLifecycle(record.instanceId, "active");
				return this.get(record.instanceId)!;
			} catch (cause) {
				const diagnostic = cause instanceof Error ? cause.message : String(cause);
				this.#setLifecycle(record.instanceId, "recovery-required", diagnostic);
				throw cause;
			}
		});
	}

	async import(request: ImportWorkspaceRequest): Promise<WorkspaceRecord> {
		this.#requireInitialized();
		return this.#withLease(request.repositoryId, async () => {
			const repositoryRoot = await this.#canonicalExistingDirectory(request.repositoryPath, "repository");
			await this.#assertRepositoryId(request.repositoryId, repositoryRoot);
			this.#bindRepository(request.repositoryId, repositoryRoot);
			const workspacePath = await this.#canonicalExistingDirectory(request.workspacePath, "workspace");
			this.#assertPathUnused(workspacePath);
			const current = await this.#worktree(repositoryRoot, workspacePath);
			if (current.detached || !current.branch)
				throw error("branch-unexpected", "Imported worktree must have an attached branch");
			const ownership = request.ownership ?? "imported-user";
			const repositoryRootOwnership = workspacePath === repositoryRoot;
			if (repositoryRootOwnership && ownership !== "repository-root")
				throw error("repository-root-protected", "Repository root must be recorded with repository-root ownership");
			if (!repositoryRootOwnership && ownership === "repository-root")
				throw error("repository-root-protected", "Only the repository root may use repository-root ownership");
			const now = this.#now();
			const record: WorkspaceRecord = {
				repositoryId: request.repositoryId,
				repositoryRoot,
				canonicalPath: workspacePath,
				instanceId: this.#ids.instanceId(),
				ownership,
				branch: current.branch,
				sourceCommit: current.head,
				expectedHead: current.head,
				lifecycle: "active",
				createdAt: now,
				updatedAt: now,
			};
			this.#insert(record);
			return record;
		});
	}

	async archive(request: ArchiveWorkspaceRequest): Promise<WorkspaceRecord> {
		this.#requireInitialized();
		const current = this.get(request.instanceId);
		if (!current) throw error("worktree-not-found", "Workspace record was not found");
		if (current.lifecycle !== "active") {
			if (
				current.lifecycle === "archiving" &&
				this.#database.query("SELECT 1 FROM repository_leases WHERE repository_id=?").get(current.repositoryId)
			)
				throw error("mutation-in-progress", "Another mutation owns this repository");
			throw error("recovery-required", "Workspace is not in an archiveable lifecycle state");
		}
		if (current.ownership === "repository-root")
			throw error("repository-root-protected", "Repository root worktrees cannot be archived");
		if (current.ownership !== "managed")
			throw error("ownership-protected", "Imported and detected worktrees are never deleted by the authority");
		return this.#withLease(current.repositoryId, async () => {
			const record = this.get(request.instanceId);
			if (record?.lifecycle !== "active")
				throw error("recovery-required", "Workspace changed while waiting for mutation lease");
			if (record.ownership !== "managed")
				throw error("ownership-protected", "Workspace ownership changed while waiting for mutation lease");
			this.#setLifecycle(record.instanceId, "archiving");
			try {
				await this.#verifyIdentity(record, true);
				const status = await this.#git(record.canonicalPath, ["status", "--porcelain=v1"]);
				if (status.exitCode !== 0)
					throw error("identity-stale", "Unable to inspect workspace cleanliness", status.stderr);
				if (status.stdout.trim())
					throw error("worktree-dirty", "Managed workspace has uncommitted changes", status.stdout);
				const removal = await this.#git(record.repositoryRoot, ["worktree", "remove", record.canonicalPath]);
				if (removal.exitCode !== 0)
					throw error(
						"archive-failed",
						"Git failed to remove managed workspace",
						removal.stderr || removal.stdout,
					);
				const remaining = await this.#worktrees(record.repositoryRoot);
				if (remaining.some(worktree => worktree.path === record.canonicalPath))
					throw error("archive-failed", "Git reported removal but worktree metadata remains");
				this.#setLifecycle(record.instanceId, "archived", undefined, this.#now());
				return this.get(record.instanceId)!;
			} catch (cause) {
				const diagnostic = cause instanceof Error ? cause.message : String(cause);
				this.#setLifecycle(record.instanceId, "archiving", diagnostic);
				throw cause;
			}
		});
	}

	/**
	 * Advances the expected commit from the checked-out worktree itself. Callers
	 * cannot nominate a commit: only a clean fast-forward on the bound branch seals.
	 */
	async seal(request: SealWorkspaceRequest): Promise<WorkspaceRecord> {
		this.#requireInitialized();
		const current = this.get(request.instanceId);
		if (!current) throw error("worktree-not-found", "Workspace record was not found");
		if (current.lifecycle !== "active")
			throw error("recovery-required", "Workspace is not in a sealable lifecycle state");
		return this.#withLease(current.repositoryId, async () => {
			const record = this.get(request.instanceId);
			if (record?.lifecycle !== "active")
				throw error("recovery-required", "Workspace changed while waiting for mutation lease");
			await this.#assertRepositoryId(record.repositoryId, record.repositoryRoot);
			const metadata = await this.#worktree(record.repositoryRoot, record.canonicalPath);
			if (metadata.detached || metadata.branch !== record.branch)
				throw error("branch-unexpected", "Workspace branch no longer matches its immutable identity");
			const status = await this.#git(record.canonicalPath, ["status", "--porcelain=v1"]);
			if (status.exitCode !== 0)
				throw error("identity-stale", "Unable to inspect workspace cleanliness", status.stderr);
			if (status.stdout.trim()) throw error("worktree-dirty", "Workspace has uncommitted changes");
			if (metadata.head === record.expectedHead) return record;
			const ancestry = await this.#git(record.canonicalPath, [
				"merge-base",
				"--is-ancestor",
				record.expectedHead,
				metadata.head,
			]);
			if (ancestry.exitCode !== 0)
				throw error("head-rewrite", "Workspace HEAD does not fast-forward its expected commit", ancestry.stderr);
			this.#database.run("UPDATE workspaces SET expected_head=?, updated_at=? WHERE instance_id=?", [
				metadata.head,
				this.#now(),
				record.instanceId,
			]);
			return this.get(record.instanceId)!;
		});
	}

	/** Reconciles only durable transitional records; it never retries a deletion or creation. */
	async recover(): Promise<WorkspaceRecord[]> {
		const recovered: WorkspaceRecord[] = [];
		for (const record of this.list()) {
			if (record.lifecycle === "creating") {
				try {
					await this.#verifyIdentity(record, true);
					this.#setLifecycle(record.instanceId, "active");
				} catch (cause) {
					this.#setLifecycle(record.instanceId, "recovery-required", this.#diagnostic(cause));
				}
				recovered.push(this.get(record.instanceId)!);
			}
			if (record.lifecycle === "archiving") {
				try {
					const metadata = await this.#worktrees(record.repositoryRoot);
					const workspace = metadata.find(worktree => worktree.path === record.canonicalPath);
					if (!workspace) this.#setLifecycle(record.instanceId, "archived", undefined, this.#now());
					else {
						await this.#verifyIdentity(record, true);
						this.#setLifecycle(record.instanceId, "active", record.recoveryDiagnostic);
					}
				} catch (cause) {
					this.#setLifecycle(record.instanceId, "recovery-required", this.#diagnostic(cause));
				}
				recovered.push(this.get(record.instanceId)!);
			}
		}
		return recovered;
	}

	#migrate(): void {
		const schema = this.#database.query("PRAGMA user_version").get();
		if (!schema || typeof schema !== "object" || !("user_version" in schema))
			throw error("worktree-metadata-invalid", "Workspace schema version is invalid");
		const version = Number(schema.user_version);
		if (!Number.isInteger(version)) throw error("worktree-metadata-invalid", "Workspace schema version is invalid");
		if (version > WORKSPACE_SCHEMA_VERSION)
			throw error("unsupported-schema", "Workspace database schema is newer than this authority");
		this.#database.run("BEGIN IMMEDIATE");
		try {
			this.#database.run(
				"CREATE TABLE IF NOT EXISTS workspaces(instance_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository_root TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE, ownership TEXT NOT NULL, branch TEXT NOT NULL, source_commit TEXT NOT NULL, expected_head TEXT NOT NULL, lifecycle TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, recovery_diagnostic TEXT)",
			);
			this.#database.run(
				"CREATE TABLE IF NOT EXISTS repository_leases(repository_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, acquired_at INTEGER NOT NULL)",
			);
			if (version < 2) {
				const conflictingId = this.#database
					.query(
						"SELECT repository_id FROM workspaces GROUP BY repository_id HAVING COUNT(DISTINCT repository_root) > 1 LIMIT 1",
					)
					.get();
				const conflictingRoot = this.#database
					.query(
						"SELECT repository_root FROM workspaces GROUP BY repository_root HAVING COUNT(DISTINCT repository_id) > 1 LIMIT 1",
					)
					.get();
				if (conflictingId || conflictingRoot)
					throw error(
						"repository-mismatch",
						"Persisted workspace records contain conflicting repository bindings",
					);
			}
			this.#database.run(
				"CREATE TABLE IF NOT EXISTS repository_roots(repository_id TEXT PRIMARY KEY, repository_root TEXT NOT NULL UNIQUE)",
			);
			if (version < 2) {
				this.#database.run(
					"INSERT INTO repository_roots(repository_id, repository_root) SELECT repository_id, MIN(repository_root) FROM workspaces GROUP BY repository_id",
				);
			}
			this.#database.run(`PRAGMA user_version = ${WORKSPACE_SCHEMA_VERSION}`);
			this.#database.run("COMMIT");
		} catch (cause) {
			try {
				this.#database.run("ROLLBACK");
			} catch {}
			throw cause;
		}
	}

	#read(value: unknown): WorkspaceRecord {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw error("worktree-metadata-invalid", "persisted workspace is invalid");
		const row = Object.fromEntries(Object.entries(value));
		const archivedAt = row.archived_at === null ? undefined : asNumber(row.archived_at, "archived_at");
		const diagnostic =
			row.recovery_diagnostic === null ? undefined : asText(row.recovery_diagnostic, "recovery_diagnostic");
		return {
			instanceId: asText(row.instance_id, "instance_id"),
			repositoryId: asText(row.repository_id, "repository_id"),
			repositoryRoot: asText(row.repository_root, "repository_root"),
			canonicalPath: asText(row.canonical_path, "canonical_path"),
			ownership: enumValue(row.ownership, workspaceOwnerships, "ownership"),
			branch: asText(row.branch, "branch"),
			sourceCommit: asText(row.source_commit, "source_commit"),
			expectedHead: asText(row.expected_head, "expected_head"),
			lifecycle: enumValue(row.lifecycle, workspaceLifecycleStates, "lifecycle"),
			createdAt: asNumber(row.created_at, "created_at"),
			updatedAt: asNumber(row.updated_at, "updated_at"),
			...(archivedAt === undefined ? {} : { archivedAt }),
			...(diagnostic === undefined ? {} : { recoveryDiagnostic: diagnostic }),
		};
	}

	#insert(record: WorkspaceRecord): void {
		try {
			this.#database.run(
				"INSERT INTO workspaces(instance_id, repository_id, repository_root, canonical_path, ownership, branch, source_commit, expected_head, lifecycle, created_at, updated_at, archived_at, recovery_diagnostic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					record.instanceId,
					record.repositoryId,
					record.repositoryRoot,
					record.canonicalPath,
					record.ownership,
					record.branch,
					record.sourceCommit,
					record.expectedHead,
					record.lifecycle,
					record.createdAt,
					record.updatedAt,
					null,
					null,
				],
			);
		} catch (cause) {
			if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed"))
				throw error("duplicate-path", "A workspace record already owns this canonical path");
			throw cause;
		}
	}

	#setLifecycle(
		instanceId: string,
		lifecycle: WorkspaceLifecycleState,
		diagnostic?: string,
		archivedAt?: number,
	): void {
		this.#database.run(
			"UPDATE workspaces SET lifecycle=?, updated_at=?, archived_at=?, recovery_diagnostic=? WHERE instance_id=?",
			[lifecycle, this.#now(), archivedAt ?? null, diagnostic ?? null, instanceId],
		);
	}

	async #canonicalExistingDirectory(path: string, label: string): Promise<string> {
		const absolute = this.#absolute(path);
		await this.#assertNoSymlink(absolute);
		const stat = await this.#filesystem.lstat(absolute);
		if (!stat?.isDirectory()) throw error("invalid-path", `${label} path is not a directory`);
		return this.#filesystem.realpath(absolute);
	}

	async #canonicalNewPath(path: string): Promise<string> {
		const absolute = this.#absolute(path);
		await this.#assertNoSymlink(absolute);
		if (await this.#filesystem.lstat(absolute))
			throw error("path-reused", "Target path already exists and cannot be reused");
		const parent = dirname(absolute);
		const parentStat = await this.#filesystem.lstat(parent);
		if (!parentStat?.isDirectory()) throw error("invalid-path", "Target parent path is not a directory");
		return resolve(await this.#filesystem.realpath(parent), basename(absolute));
	}

	#absolute(path: string): string {
		if (!isAbsolute(path)) throw error("invalid-path", "Workspace paths must be absolute");
		return resolve(path);
	}

	async #assertNoSymlink(path: string): Promise<void> {
		for (let cursor = path; ; cursor = dirname(cursor)) {
			const stat = await this.#filesystem.lstat(cursor);
			if (stat?.isSymbolicLink()) throw error("path-symlink", "Workspace paths must not traverse symlinks");
			if (cursor === dirname(cursor)) return;
		}
	}

	#assertPathUnused(path: string): void {
		if (this.#database.query("SELECT 1 FROM workspaces WHERE canonical_path=?").get(path))
			throw error("duplicate-path", "A workspace record already owns this canonical path");
	}

	async #assertRepositoryId(repositoryId: string, repositoryRoot: string): Promise<void> {
		const value = this.#database
			.query("SELECT repository_root FROM repository_roots WHERE repository_id=?")
			.get(repositoryId);
		if (value !== null && value !== undefined) {
			if (typeof value !== "object" || !("repository_root" in value) || typeof value.repository_root !== "string")
				throw error("worktree-metadata-invalid", "Persisted repository binding is invalid");
			if (value.repository_root !== repositoryRoot)
				throw error("repository-mismatch", "Repository id is already bound to another repository root");
		}
		const rootBinding = this.#database
			.query("SELECT repository_id FROM repository_roots WHERE repository_root=?")
			.get(repositoryRoot);
		if (rootBinding !== null && rootBinding !== undefined) {
			if (
				typeof rootBinding !== "object" ||
				!("repository_id" in rootBinding) ||
				typeof rootBinding.repository_id !== "string"
			)
				throw error("worktree-metadata-invalid", "Persisted repository binding is invalid");
			if (rootBinding.repository_id !== repositoryId)
				throw error("repository-mismatch", "Repository root is already bound to another repository id");
		}
		const actualRoot = await this.#git(repositoryRoot, ["rev-parse", "--show-toplevel"]);
		if (actualRoot.exitCode !== 0 || actualRoot.stdout.trim() !== repositoryRoot)
			throw error(
				"repository-mismatch",
				"Repository path is not its canonical Git repository root",
				actualRoot.stderr,
			);
	}

	#bindRepository(repositoryId: string, repositoryRoot: string): void {
		const byRoot = this.#database
			.query("SELECT repository_id FROM repository_roots WHERE repository_root=?")
			.get(repositoryRoot);
		if (byRoot !== null && byRoot !== undefined) {
			if (typeof byRoot !== "object" || !("repository_id" in byRoot) || typeof byRoot.repository_id !== "string")
				throw error("worktree-metadata-invalid", "Persisted repository binding is invalid");
			if (byRoot.repository_id !== repositoryId)
				throw error("repository-mismatch", "Repository root is already bound to another repository id");
		}
		this.#database.run("INSERT OR IGNORE INTO repository_roots(repository_id, repository_root) VALUES (?, ?)", [
			repositoryId,
			repositoryRoot,
		]);
	}

	async #resolveCommit(repositoryRoot: string, sourceCommit: string): Promise<string> {
		const resolved = await this.#git(repositoryRoot, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]);
		if (resolved.exitCode !== 0 || !resolved.stdout.trim())
			throw error("identity-stale", "Source commit does not resolve in the selected repository", resolved.stderr);
		return resolved.stdout.trim();
	}

	async #validateBranch(repositoryRoot: string, branch: string): Promise<void> {
		if (!branch || branch.startsWith("-") || branch.includes("\0"))
			throw error("branch-invalid", "Workspace branch name is invalid");
		const validation = await this.#git(repositoryRoot, ["check-ref-format", "--branch", branch]);
		if (validation.exitCode !== 0)
			throw error("branch-invalid", "Workspace branch name is invalid", validation.stderr);
	}

	async #worktrees(repositoryRoot: string): Promise<GitWorktreeMetadata[]> {
		const result = await this.#git(repositoryRoot, ["worktree", "list", "--porcelain"]);
		if (result.exitCode !== 0)
			throw error("identity-stale", "Unable to re-read Git worktree metadata", result.stderr || result.stdout);
		return parseWorktreeList(result.stdout);
	}

	async #worktree(repositoryRoot: string, workspacePath: string): Promise<GitWorktreeMetadata> {
		const metadata = (await this.#worktrees(repositoryRoot)).find(worktree => worktree.path === workspacePath);
		if (!metadata) throw error("worktree-not-found", "Workspace is absent from Git worktree metadata");
		return metadata;
	}

	async #verifyIdentity(record: WorkspaceRecord, requireExpectedHead: boolean): Promise<void> {
		await this.#assertRepositoryId(record.repositoryId, record.repositoryRoot);
		const metadata = await this.#worktree(record.repositoryRoot, record.canonicalPath);
		if (metadata.detached || metadata.branch !== record.branch)
			throw error("branch-unexpected", "Workspace branch no longer matches its immutable identity");
		if (requireExpectedHead && metadata.head !== record.expectedHead)
			throw error("head-unexpected", "Workspace HEAD no longer matches its expected commit");
	}

	async #git(repositoryRoot: string, arguments_: readonly string[]): Promise<GitProcessResult> {
		return this.#process.run("git", ["-C", repositoryRoot, ...arguments_]);
	}

	async #withLease<T>(repositoryId: string, action: () => Promise<T>): Promise<T> {
		const leaseId = this.#ids.leaseId();
		this.#database.run("BEGIN IMMEDIATE");
		try {
			const active = this.#database
				.query("SELECT lease_id FROM repository_leases WHERE repository_id=?")
				.get(repositoryId);
			if (active) throw error("mutation-in-progress", "Another mutation owns this repository");
			this.#database.run("INSERT INTO repository_leases(repository_id, lease_id, acquired_at) VALUES (?, ?, ?)", [
				repositoryId,
				leaseId,
				this.#now(),
			]);
			this.#database.run("COMMIT");
		} catch (cause) {
			try {
				this.#database.run("ROLLBACK");
			} catch {}
			throw cause;
		}
		try {
			return await action();
		} finally {
			this.#database.run("DELETE FROM repository_leases WHERE repository_id=? AND lease_id=?", [
				repositoryId,
				leaseId,
			]);
		}
	}

	#now(): number {
		const now = this.#clock.now();
		if (!Number.isFinite(now)) throw error("worktree-metadata-invalid", "Clock returned an invalid timestamp");
		return now;
	}

	#diagnostic(cause: unknown): string {
		return cause instanceof Error ? cause.message : String(cause);
	}

	#requireInitialized(): void {
		if (!this.#initialized) throw error("recovery-required", "Workspace authority must be initialized before use");
	}
}
