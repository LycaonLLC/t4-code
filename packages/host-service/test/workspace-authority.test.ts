import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type GitProcessResult,
	WorkspaceAuthority,
	WorkspaceAuthorityError,
	type WorkspaceAuthorityErrorCode,
	type WorkspaceProcessRunner,
} from "../src/workspace-authority.ts";

setDefaultTimeout(30_000);

async function git(cwd: string, arguments_: readonly string[]): Promise<GitProcessResult> {
	const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...arguments_], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

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

async function requireGit(cwd: string, arguments_: readonly string[]): Promise<string> {
	const result = await git(cwd, arguments_);
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-authority-")));
	const repository = path.join(root, "repository");
	await fs.mkdir(repository);
	await requireGit(repository, ["init"]);
	await requireGit(repository, ["config", "user.email", "test@example.invalid"]);
	await requireGit(repository, ["config", "user.name", "Workspace Test"]);
	await fs.writeFile(path.join(repository, "README.md"), "initial\n");
	await requireGit(repository, ["add", "README.md"]);
	await requireGit(repository, ["commit", "-m", "initial"]);
	return { root, repository, head: await requireGit(repository, ["rev-parse", "HEAD"]) };
}

async function createManaged(authority: WorkspaceAuthority, repository: string, head: string, name = "managed") {
	return authority.create({
		repositoryId: "repository-a",
		repositoryPath: repository,
		targetPath: path.join(path.dirname(repository), name),
		branch: `agent/${name}`,
		sourceCommit: head,
	});
}

async function expectAuthorityError(promise: Promise<unknown>, code: WorkspaceAuthorityErrorCode): Promise<void> {
	try {
		await promise;
		throw new Error(`Expected workspace authority error ${code}`);
	} catch (cause) {
		if (!(cause instanceof WorkspaceAuthorityError)) throw cause;
		expect(cause.code).toBe(code);
	}
}

describe("workspace authority", () => {
	test("persists a one-to-one repository id and canonical root binding", async () => {
		const setup = await fixture();
		const other = await fixture();
		const authority = await WorkspaceAuthority.open({ databasePath: path.join(setup.root, "authority.sqlite") });
		try {
			await createManaged(authority, setup.repository, setup.head);
			await expectAuthorityError(
				authority.create({
					repositoryId: "repository-a",
					repositoryPath: other.repository,
					targetPath: path.join(other.root, "wrong-root"),
					branch: "agent/wrong-root",
					sourceCommit: other.head,
				}),
				"repository-mismatch",
			);
			await expectAuthorityError(
				authority.create({
					repositoryId: "repository-b",
					repositoryPath: setup.repository,
					targetPath: path.join(setup.root, "wrong-id"),
					branch: "agent/wrong-id",
					sourceCommit: setup.head,
				}),
				"repository-mismatch",
			);
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
			await fs.rm(other.root, { recursive: true, force: true });
		}
	});

	test("rejects legacy metadata that aliases one repository root across ids", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-binding-migration-")));
		const databasePath = path.join(root, "authority.sqlite");
		try {
			const database = new Database(databasePath);
			database.run(
				"CREATE TABLE workspaces(instance_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository_root TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE, ownership TEXT NOT NULL, branch TEXT NOT NULL, source_commit TEXT NOT NULL, expected_head TEXT NOT NULL, lifecycle TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, recovery_diagnostic TEXT)",
			);
			const insert = database.prepare(
				"INSERT INTO workspaces(instance_id, repository_id, repository_root, canonical_path, ownership, branch, source_commit, expected_head, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, 'managed', ?, 'head', 'head', 'active', 1, 1)",
			);
			insert.run("workspace-a", "repository-a", "/tmp/shared-repository", "/tmp/workspace-a", "agent/a");
			insert.run("workspace-b", "repository-b", "/tmp/shared-repository", "/tmp/workspace-b", "agent/b");
			database.run("PRAGMA user_version = 1");
			database.close();

			try {
				new WorkspaceAuthority({ databasePath });
				throw new Error("Expected conflicting repository binding rejection");
			} catch (cause) {
				if (!(cause instanceof WorkspaceAuthorityError)) throw cause;
				expect(cause.code).toBe("repository-mismatch");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects database paths that traverse an ancestor symlink", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-database-path-")));
		try {
			const storage = path.join(root, "storage");
			const linked = path.join(root, "linked");
			await fs.mkdir(storage);
			await fs.symlink(storage, linked, "dir");
			try {
				new WorkspaceAuthority({ databasePath: path.join(linked, "nested", "authority.sqlite") });
				throw new Error("Expected workspace database symlink rejection");
			} catch (cause) {
				if (!(cause instanceof WorkspaceAuthorityError)) throw cause;
				expect(cause.code).toBe("path-symlink");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("creates an immutable managed identity and removes only its verified clean worktree", async () => {
		const setup = await fixture();
		const authority = await WorkspaceAuthority.open({ databasePath: path.join(setup.root, "authority.sqlite") });
		try {
			const workspace = await createManaged(authority, setup.repository, setup.head);
			expect(workspace).toMatchObject({
				repositoryId: "repository-a",
				ownership: "managed",
				branch: "agent/managed",
				sourceCommit: setup.head,
				expectedHead: setup.head,
				lifecycle: "active",
			});
			expect(authority.resolve(workspace.canonicalPath)?.instanceId).toBe(workspace.instanceId);

			const archived = await authority.archive({ instanceId: workspace.instanceId });
			expect(archived.lifecycle).toBe("archived");
			expect(
				await fs
					.stat(workspace.canonicalPath)
					.then(() => true)
					.catch(() => false),
			).toBeFalse();
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("persists create failure diagnostics and leaves recovery to explicit evidence", async () => {
		const setup = await fixture();
		const failing: WorkspaceProcessRunner = {
			async run(command, arguments_) {
				if (command === "git" && arguments_.includes("add") && arguments_.includes("worktree"))
					return { exitCode: 1, stdout: "", stderr: "injected create failure" };
				return realProcess.run(command, arguments_);
			},
		};
		const authority = await WorkspaceAuthority.open({
			databasePath: path.join(setup.root, "authority.sqlite"),
			process: failing,
		});
		try {
			await expectAuthorityError(createManaged(authority, setup.repository, setup.head), "create-failed");
			const [record] = authority.list();
			expect(record).toMatchObject({
				lifecycle: "recovery-required",
				recoveryDiagnostic: "injected create failure",
			});
			await authority.recover();
			expect(authority.get(record.instanceId)).toMatchObject({ lifecycle: "recovery-required" });
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("keeps failed imports unrecorded when Git metadata inspection fails", async () => {
		const setup = await fixture();
		const external = path.join(setup.root, "external");
		await requireGit(setup.repository, ["worktree", "add", "-b", "user/external", external, setup.head]);
		const failing: WorkspaceProcessRunner = {
			async run(command, arguments_) {
				if (command === "git" && arguments_.includes("list") && arguments_.includes("worktree"))
					return { exitCode: 1, stdout: "", stderr: "injected import inspection failure" };
				return realProcess.run(command, arguments_);
			},
		};
		const authority = await WorkspaceAuthority.open({
			databasePath: path.join(setup.root, "authority.sqlite"),
			process: failing,
		});
		try {
			await expectAuthorityError(
				authority.import({
					repositoryId: "repository-a",
					repositoryPath: setup.repository,
					workspacePath: external,
				}),
				"identity-stale",
			);
			expect(authority.list()).toEqual([]);
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("imports without taking deletion authority and protects repository roots", async () => {
		const setup = await fixture();
		const external = path.join(setup.root, "external");
		await requireGit(setup.repository, ["worktree", "add", "-b", "user/external", external, setup.head]);
		const authority = await WorkspaceAuthority.open({ databasePath: path.join(setup.root, "authority.sqlite") });
		try {
			const imported = await authority.import({
				repositoryId: "repository-a",
				repositoryPath: setup.repository,
				workspacePath: external,
			});
			await expectAuthorityError(authority.archive({ instanceId: imported.instanceId }), "ownership-protected");
			expect(await fs.stat(external).then(stat => stat.isDirectory())).toBeTrue();

			const rootRecord = await authority.import({
				repositoryId: "repository-a",
				repositoryPath: setup.repository,
				workspacePath: setup.repository,
				ownership: "repository-root",
			});
			await expectAuthorityError(
				authority.archive({ instanceId: rootRecord.instanceId }),
				"repository-root-protected",
			);
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("rejects path reuse, duplicate canonical records, and symlink targets", async () => {
		const setup = await fixture();
		const authority = await WorkspaceAuthority.open({ databasePath: path.join(setup.root, "authority.sqlite") });
		try {
			const workspace = await createManaged(authority, setup.repository, setup.head);
			await expectAuthorityError(
				authority.import({
					repositoryId: "repository-a",
					repositoryPath: setup.repository,
					workspacePath: workspace.canonicalPath,
				}),
				"duplicate-path",
			);
			const linkedParent = path.join(setup.root, "linked-parent");
			await fs.symlink(setup.root, linkedParent, "dir");
			await expectAuthorityError(
				authority.create({
					repositoryId: "repository-a",
					repositoryPath: setup.repository,
					targetPath: path.join(linkedParent, "reused"),
					branch: "agent/reused",
					sourceCommit: setup.head,
				}),
				"path-symlink",
			);
			const reused = path.join(setup.root, "reused");
			await fs.mkdir(reused);
			await expectAuthorityError(
				authority.create({
					repositoryId: "repository-a",
					repositoryPath: setup.repository,
					targetPath: reused,
					branch: "agent/reused",
					sourceCommit: setup.head,
				}),
				"path-reused",
			);
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("refuses dirty worktrees and expected-head drift before removal", async () => {
		const setup = await fixture();
		const authority = await WorkspaceAuthority.open({ databasePath: path.join(setup.root, "authority.sqlite") });
		try {
			const dirty = await createManaged(authority, setup.repository, setup.head, "dirty");
			await fs.writeFile(path.join(dirty.canonicalPath, "dirty.txt"), "dirty\n");
			await expectAuthorityError(authority.archive({ instanceId: dirty.instanceId }), "worktree-dirty");
			expect(await fs.stat(dirty.canonicalPath).then(stat => stat.isDirectory())).toBeTrue();
			await authority.recover();
			expect(authority.get(dirty.instanceId)).toMatchObject({
				lifecycle: "active",
				recoveryDiagnostic: "Managed workspace has uncommitted changes",
			});

			const drifted = await createManaged(authority, setup.repository, setup.head, "drifted");
			await fs.writeFile(path.join(drifted.canonicalPath, "committed.txt"), "drifted\n");
			await requireGit(drifted.canonicalPath, ["add", "committed.txt"]);
			await requireGit(drifted.canonicalPath, ["commit", "-m", "drift"]);
			await expectAuthorityError(authority.archive({ instanceId: drifted.instanceId }), "head-unexpected");
			expect(await fs.stat(drifted.canonicalPath).then(stat => stat.isDirectory())).toBeTrue();

			const branchChanged = await createManaged(authority, setup.repository, setup.head, "branch-changed");
			await requireGit(branchChanged.canonicalPath, ["checkout", "-b", "agent/unexpected"]);
			await expectAuthorityError(authority.archive({ instanceId: branchChanged.instanceId }), "branch-unexpected");
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("seals only clean fast-forward commits and rejects branch option injection", async () => {
		const setup = await fixture();
		const authority = await WorkspaceAuthority.open({ databasePath: path.join(setup.root, "authority.sqlite") });
		try {
			const workspace = await createManaged(authority, setup.repository, setup.head, "seal");
			await fs.writeFile(path.join(workspace.canonicalPath, "sealed.txt"), "sealed\n");
			await requireGit(workspace.canonicalPath, ["add", "sealed.txt"]);
			await requireGit(workspace.canonicalPath, ["commit", "-m", "seal"]);
			const expectedHead = await requireGit(workspace.canonicalPath, ["rev-parse", "HEAD"]);
			expect(await authority.seal({ instanceId: workspace.instanceId })).toMatchObject({ expectedHead });

			await requireGit(workspace.canonicalPath, ["reset", "--hard", "HEAD~1"]);
			await expectAuthorityError(authority.seal({ instanceId: workspace.instanceId }), "head-rewrite");
			await expectAuthorityError(
				authority.create({
					repositoryId: "repository-a",
					repositoryPath: setup.repository,
					targetPath: path.join(setup.root, "unsafe-branch"),
					branch: "--unsafe",
					sourceCommit: setup.head,
				}),
				"branch-invalid",
			);
			expect(authority.list()).toHaveLength(1);
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("preserves archive failures as diagnosable transitional records", async () => {
		const setup = await fixture();
		const failing: WorkspaceProcessRunner = {
			async run(command, arguments_) {
				if (command === "git" && arguments_.includes("remove") && arguments_.includes("worktree"))
					return { exitCode: 1, stdout: "", stderr: "injected archive failure" };
				return realProcess.run(command, arguments_);
			},
		};
		const authority = await WorkspaceAuthority.open({
			databasePath: path.join(setup.root, "authority.sqlite"),
			process: failing,
		});
		try {
			const workspace = await createManaged(authority, setup.repository, setup.head);
			await expectAuthorityError(authority.archive({ instanceId: workspace.instanceId }), "archive-failed");
			expect(authority.get(workspace.instanceId)).toMatchObject({
				lifecycle: "archiving",
				recoveryDiagnostic: "Git failed to remove managed workspace",
			});
			await authority.recover();
			expect(authority.get(workspace.instanceId)).toMatchObject({
				lifecycle: "active",
				recoveryDiagnostic: "Git failed to remove managed workspace",
			});
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("recovers interrupted creation and archival from authoritative Git metadata", async () => {
		const setup = await fixture();
		const databasePath = path.join(setup.root, "authority.sqlite");
		const authority = await WorkspaceAuthority.open({ databasePath });
		try {
			const creating = await createManaged(authority, setup.repository, setup.head, "creating");
			const database = new Database(databasePath);
			database.run("UPDATE workspaces SET lifecycle='creating' WHERE instance_id=?", [creating.instanceId]);
			database.run("INSERT INTO repository_leases(repository_id, lease_id, acquired_at) VALUES (?, ?, ?)", [
				"repository-a",
				"crashed-owner",
				0,
			]);
			database.close();
			authority.close();

			const reopened = await WorkspaceAuthority.open({ databasePath });
			expect(reopened.get(creating.instanceId)).toMatchObject({ lifecycle: "active" });
			const archiving = await createManaged(reopened, setup.repository, setup.head, "archiving");
			const secondDatabase = new Database(databasePath);
			secondDatabase.run("UPDATE workspaces SET lifecycle='archiving' WHERE instance_id=?", [archiving.instanceId]);
			secondDatabase.close();
			await requireGit(setup.repository, ["worktree", "remove", archiving.canonicalPath]);
			reopened.close();

			const afterRemoval = await WorkspaceAuthority.open({ databasePath });
			expect(afterRemoval.get(archiving.instanceId)).toMatchObject({ lifecycle: "archived" });
			afterRemoval.close();
		} finally {
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("marks interrupted workspaces recovery-required when recovery metadata is unavailable", async () => {
		const setup = await fixture();
		const databasePath = path.join(setup.root, "authority.sqlite");
		const authority = await WorkspaceAuthority.open({ databasePath });
		try {
			const workspace = await createManaged(authority, setup.repository, setup.head);
			const database = new Database(databasePath);
			database.run("UPDATE workspaces SET lifecycle='creating' WHERE instance_id=?", [workspace.instanceId]);
			database.close();
			authority.close();

			const failing: WorkspaceProcessRunner = {
				async run(command, arguments_) {
					if (command === "git" && arguments_.includes("list") && arguments_.includes("worktree"))
						return { exitCode: 1, stdout: "", stderr: "injected recovery inspection failure" };
					return realProcess.run(command, arguments_);
				},
			};
			const reopened = await WorkspaceAuthority.open({ databasePath, process: failing });
			expect(reopened.get(workspace.instanceId)).toMatchObject({
				lifecycle: "recovery-required",
				recoveryDiagnostic: "Unable to re-read Git worktree metadata",
			});
			reopened.close();
		} finally {
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});

	test("serializes concurrent destructive mutation with a per-repository lease", async () => {
		const setup = await fixture();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const delayed: WorkspaceProcessRunner = {
			async run(command, arguments_) {
				if (command === "git" && arguments_.includes("remove") && arguments_.includes("worktree")) {
					entered.resolve();
					await gate.promise;
				}
				return realProcess.run(command, arguments_);
			},
		};
		const authority = await WorkspaceAuthority.open({
			databasePath: path.join(setup.root, "authority.sqlite"),
			process: delayed,
		});
		try {
			const workspace = await createManaged(authority, setup.repository, setup.head);
			const first = authority.archive({ instanceId: workspace.instanceId });
			await entered.promise;
			await expectAuthorityError(authority.archive({ instanceId: workspace.instanceId }), "mutation-in-progress");
			gate.resolve();
			expect((await first).lifecycle).toBe("archived");
		} finally {
			authority.close();
			await fs.rm(setup.root, { recursive: true, force: true });
		}
	});
});
