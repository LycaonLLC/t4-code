import { Database } from "bun:sqlite";
import { lstat, unlink } from "node:fs/promises";
import path from "node:path";

const AUTH_SCHEMA_VERSION = 6;
const AUTH_COLUMNS = [
	"id",
	"provider",
	"credential_type",
	"data",
	"disabled_cause",
	"identity_key",
	"created_at",
	"updated_at",
] as const;
const SETTINGS_COLUMNS = ["key", "value", "updated_at"] as const;
const SECRET_SETTING_KEYS = [
	"auth.broker.token",
	"hindsight.apiToken",
	"searxng.token",
	"dev.autoqaPush.token",
] as const;

type ColumnRow = { name?: unknown };
type CountRow = { count?: unknown };
type VersionRow = { version?: unknown };

function tableExists(database: Database, table: string): boolean {
	const row = database
		.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table) as { present?: unknown } | null;
	return row?.present === 1;
}

function requireExactColumns(database: Database, table: string, expected: readonly string[]): void {
	const rows = database.query(`PRAGMA table_info(${table})`).all() as ColumnRow[];
	const actual = rows.map(row => row.name);
	if (
		actual.length !== expected.length ||
		actual.some((column, index) => typeof column !== "string" || column !== expected[index])
	) {
		throw new Error(`unsupported ${table} schema`);
	}
}

async function removeCredentialFile(filePath: string): Promise<void> {
	let metadata;
	try {
		metadata = await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (metadata.isDirectory()) throw new Error(`credential path is a directory: ${path.basename(filePath)}`);
	await unlink(filePath);
}

export async function scrubOMPProfileCredentials(input: {
	readonly agentDir: string;
	readonly home: string;
}): Promise<{ credentialRows: number; settingRows: number }> {
	const agentDir = path.resolve(input.agentDir);
	const home = path.resolve(input.home);
	const profilesRoot = path.join(home, ".omp", "profiles") + path.sep;
	if (!path.isAbsolute(input.agentDir) || !path.isAbsolute(input.home) || !agentDir.startsWith(profilesRoot)) {
		throw new Error("OMP credential scrub paths are outside the profile home");
	}
	const databasePath = path.join(agentDir, "agent.db");
	const tokenPath = path.join(home, ".omp", "auth-broker.token");
	const snapshotPath = path.join(home, ".omp", "cache", "auth-broker-snapshot.enc");

	let databaseMetadata;
	try {
		databaseMetadata = await lstat(databasePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
			try {
				await lstat(sidecar);
				throw new Error("agent database sidecar exists without agent.db");
			} catch (sidecarError) {
				if ((sidecarError as NodeJS.ErrnoException).code !== "ENOENT") throw sidecarError;
			}
		}
		await removeCredentialFile(tokenPath);
		await removeCredentialFile(snapshotPath);
		return { credentialRows: 0, settingRows: 0 };
	}
	if (!databaseMetadata.isFile() || databaseMetadata.isSymbolicLink()) {
		throw new Error("agent.db must be a regular file");
	}

	const database = new Database(databasePath, { create: false, readwrite: true });
	let credentialRows = 0;
	let settingRows = 0;
	try {
		database.run("PRAGMA busy_timeout = 5000");
		database.run("PRAGMA secure_delete = ON");
		const hasCredentials = tableExists(database, "auth_credentials");
		const hasSettings = tableExists(database, "settings");
		if (hasCredentials) {
			requireExactColumns(database, "auth_credentials", AUTH_COLUMNS);
			if (!tableExists(database, "auth_schema_version")) throw new Error("auth schema version is missing");
			requireExactColumns(database, "auth_schema_version", ["id", "version"]);
			const version = database.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as VersionRow | null;
			if (version?.version !== AUTH_SCHEMA_VERSION) throw new Error("unsupported auth schema version");
			const count = database.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as CountRow;
			if (typeof count.count !== "number") throw new Error("credential row count is invalid");
			credentialRows = count.count;
		}
		if (hasSettings) {
			requireExactColumns(database, "settings", SETTINGS_COLUMNS);
			const placeholders = SECRET_SETTING_KEYS.map(() => "?").join(", ");
			const count = database
				.query(`SELECT COUNT(*) AS count FROM settings WHERE key IN (${placeholders})`)
				.get(...SECRET_SETTING_KEYS) as CountRow;
			if (typeof count.count !== "number") throw new Error("secret setting row count is invalid");
			settingRows = count.count;
		}

		const scrub = database.transaction(() => {
			if (hasCredentials) database.run("DELETE FROM auth_credentials");
			if (hasSettings) {
				const placeholders = SECRET_SETTING_KEYS.map(() => "?").join(", ");
				database.query(`DELETE FROM settings WHERE key IN (${placeholders})`).run(...SECRET_SETTING_KEYS);
			}
		});
		scrub.immediate();
		database.run("PRAGMA wal_checkpoint(TRUNCATE)");
		database.run("VACUUM");
		database.run("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		database.close();
	}

	await removeCredentialFile(tokenPath);
	await removeCredentialFile(snapshotPath);
	return { credentialRows, settingRows };
}

if (import.meta.main) {
	const [agentDir, home] = process.argv.slice(2);
	if (!agentDir || !home) throw new Error("usage: scrub-omp-credentials <agent-dir> <home>");
	const result = await scrubOMPProfileCredentials({ agentDir, home });
	process.stdout.write(
		JSON.stringify({ component: "session-runtime", result: "credentials_scrubbed", ...result }) + "\n",
	);
}
