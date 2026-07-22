import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrubOMPProfileCredentials } from "./scrub-omp-credentials";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; home: string; agentDir: string; databasePath: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "t4-omp-scrub-"));
	roots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "profiles", "session-a", "agent");
	await mkdir(agentDir, { recursive: true });
	return { root, home, agentDir, databasePath: path.join(agentDir, "agent.db") };
}

function createPinnedSchema(databasePath: string): Database {
	const database = new Database(databasePath);
	database.run(`
		CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
		INSERT INTO auth_schema_version(id, version) VALUES (1, 6);
		CREATE TABLE auth_credentials (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL,
			credential_type TEXT NOT NULL,
			data TEXT NOT NULL,
			disabled_cause TEXT DEFAULT NULL,
			identity_key TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE history (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
	`);
	return database;
}

describe("OMP durable credential scrub", () => {
	test("removes only pinned credential state and preserves unrelated durable rows", async () => {
		const { home, agentDir, databasePath } = await fixture();
		const database = createPinnedSchema(databasePath);
		database.query("INSERT INTO auth_credentials(provider, credential_type, data) VALUES (?, ?, ?)").run(
			"anthropic",
			"api_key",
			JSON.stringify({ key: "must-not-remain" }),
		);
		for (const key of ["auth.broker.token", "hindsight.apiToken", "searxng.token", "dev.autoqaPush.token"]) {
			database.query("INSERT INTO settings(key, value) VALUES (?, ?)").run(key, "must-not-remain");
		}
		database.query("INSERT INTO settings(key, value) VALUES (?, ?)").run("theme", JSON.stringify("dark"));
		database.query("INSERT INTO history(id, value) VALUES (?, ?)").run(1, "unrelated session state");
		database.close();
		await mkdir(path.join(home, ".omp", "cache"), { recursive: true });
		await writeFile(path.join(home, ".omp", "auth-broker.token"), "must-not-remain", { mode: 0o600 });
		await writeFile(path.join(home, ".omp", "cache", "auth-broker-snapshot.enc"), "must-not-remain", {
			mode: 0o600,
		});

		await expect(scrubOMPProfileCredentials({ agentDir, home })).resolves.toEqual({
			credentialRows: 1,
			settingRows: 4,
		});
		const verified = new Database(databasePath, { create: false, readonly: true });
		expect((verified.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as { count: number }).count).toBe(0);
		expect((verified.query("SELECT COUNT(*) AS count FROM settings").get() as { count: number }).count).toBe(1);
		expect(verified.query("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: '"dark"' });
		expect(verified.query("SELECT value FROM history WHERE id = 1").get()).toEqual({
			value: "unrelated session state",
		});
		verified.close();
		await expect(stat(path.join(home, ".omp", "auth-broker.token"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(path.join(home, ".omp", "cache", "auth-broker-snapshot.enc"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("fails closed without mutating an unknown credential schema", async () => {
		const { home, agentDir, databasePath } = await fixture();
		const database = new Database(databasePath);
		database.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
		database.query("INSERT INTO auth_credentials(id, data) VALUES (?, ?)").run(1, "must-remain-until-reviewed");
		database.close();

		await expect(scrubOMPProfileCredentials({ agentDir, home })).rejects.toThrow("unsupported auth_credentials schema");
		const verified = new Database(databasePath, { create: false, readonly: true });
		expect((verified.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as { count: number }).count).toBe(1);
		verified.close();
	});
});
