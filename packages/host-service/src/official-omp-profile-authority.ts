import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	hostId,
	type ProjectId,
	type SessionId,
	sessionId,
	type TranscriptPageArguments,
	type TranscriptPageResult,
} from "@t4-code/host-wire";
import { FileSessionDiscovery } from "./discovery.ts";
import type {
	SessionAuthority,
	SessionAuthoritySession,
	SessionDiscovery,
	SessionRecord,
} from "./types.ts";

const TITLE_SLOT_BYTES = 256;
const METADATA_BYTES = 1024 * 1024;

interface OfficialProfileMetadata {
	readonly version: 1;
	readonly archived: Readonly<Record<string, string>>;
}

export interface OfficialOmpProfileAuthorityOptions {
	readonly sessionsRoot: string;
	readonly metadataPath: string;
}

function titleSlot(title: string, updatedAt: string): string {
	const encoder = new TextEncoder();
	const codePoints = [...title];
	const line = (value: string, pad: string): string =>
		`${JSON.stringify({ type: "title", v: 1, title: value, source: "user", updatedAt, pad })}\n`;
	let low = 0;
	let high = codePoints.length;
	let bounded = "";
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const candidate = codePoints.slice(0, middle).join("");
		if (encoder.encode(line(candidate, "")).byteLength <= TITLE_SLOT_BYTES) {
			bounded = candidate;
			low = middle + 1;
		} else high = middle - 1;
	}
	const unpadded = line(bounded, "");
	const pad = " ".repeat(TITLE_SLOT_BYTES - encoder.encode(unpadded).byteLength);
	const result = line(bounded, pad);
	if (encoder.encode(result).byteLength !== TITLE_SLOT_BYTES) throw new Error("official OMP title slot is invalid");
	return result;
}

function decodeMetadata(value: unknown): OfficialProfileMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("official OMP metadata is invalid");
	const root = value as Record<string, unknown>;
	if (root.version !== 1 || !root.archived || typeof root.archived !== "object" || Array.isArray(root.archived))
		throw new Error("official OMP metadata is invalid");
	const archived: Record<string, string> = {};
	for (const [id, timestamp] of Object.entries(root.archived)) {
		if (id.length === 0 || id.length > 256 || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))
			throw new Error("official OMP metadata is invalid");
		archived[id] = timestamp;
	}
	return { version: 1, archived };
}

/**
 * T4-owned host management for an isolated official-OMP profile. The caller
 * must give this authority an exclusive sessions root because stock OMP has no
 * cross-process writer lock. OMP remains the per-session runtime and JSONL
 * authority; this class supplies only host-wide discovery and lifecycle seams.
 */
export class OfficialOmpProfileAuthority implements SessionAuthority, SessionDiscovery {
	readonly #sessionsRoot: string;
	readonly #metadataPath: string;
	readonly #discovery: FileSessionDiscovery;
	readonly #archived = new Map<string, string>();
	#canonicalRoot?: string;
	#initialized = false;

	constructor(options: OfficialOmpProfileAuthorityOptions) {
		if (!isAbsolute(options.sessionsRoot) || !isAbsolute(options.metadataPath))
			throw new Error("official OMP authority paths must be absolute");
		this.#sessionsRoot = resolve(options.sessionsRoot);
		this.#metadataPath = resolve(options.metadataPath);
		this.#discovery = new FileSessionDiscovery(this.#sessionsRoot, undefined, hostId("official-omp"), true);
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await Promise.all([
			mkdir(this.#sessionsRoot, { recursive: true, mode: 0o700 }),
			mkdir(dirname(this.#metadataPath), { recursive: true, mode: 0o700 }),
		]);
		const rootInfo = await lstat(this.#sessionsRoot);
		const metadataRootInfo = await lstat(dirname(this.#metadataPath));
		const uid = process.getuid?.();
		if (
			!rootInfo.isDirectory() ||
			rootInfo.isSymbolicLink() ||
			!metadataRootInfo.isDirectory() ||
			metadataRootInfo.isSymbolicLink() ||
			(uid !== undefined && (rootInfo.uid !== uid || metadataRootInfo.uid !== uid))
		)
			throw new Error("official OMP authority root is unsafe");
		await Promise.all([chmod(this.#sessionsRoot, 0o700), chmod(dirname(this.#metadataPath), 0o700)]);
		this.#canonicalRoot = await realpath(this.#sessionsRoot);
		try {
			const info = await lstat(this.#metadataPath);
			if (info.isSymbolicLink() || !info.isFile() || info.size > METADATA_BYTES)
				throw new Error("official OMP metadata is invalid");
			const metadata = decodeMetadata(JSON.parse(await readFile(this.#metadataPath, "utf8")));
			for (const [id, timestamp] of Object.entries(metadata.archived)) this.#archived.set(id, timestamp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.#initialized = true;
	}

	async list(): Promise<SessionRecord[]> {
		this.#assertInitialized();
		return (await this.#discovery.list()).map(record => {
			const archivedAt = this.#archived.get(record.sessionId);
			return archivedAt ? { ...record, archivedAt } : record;
		});
	}

	async load(session: SessionRecord): Promise<SessionRecord> {
		this.#assertInitialized();
		const loaded = await this.#discovery.load(session);
		const archivedAt = this.#archived.get(loaded.sessionId);
		return archivedAt ? { ...loaded, archivedAt } : loaded;
	}

	async page(session: SessionRecord, args: TranscriptPageArguments): Promise<TranscriptPageResult> {
		this.#assertInitialized();
		if (!this.#discovery.page) throw new Error("official OMP transcript paging is unavailable");
		return this.#discovery.page(session, args);
	}

	async create(cwd: string, title = "Session"): Promise<SessionAuthoritySession> {
		this.#assertInitialized();
		const canonicalCwd = await realpath(cwd);
		if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("official OMP session cwd is unavailable");
		const id = Bun.randomUUIDv7();
		const timestamp = new Date().toISOString();
		const configuredDirectory = join(this.#sessionsRoot, "-t4");
		await mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
		const directory = await this.#assertOwnedDirectory(configuredDirectory);
		const path = join(directory, `session-${id}.jsonl`);
		const body = `${titleSlot(title, timestamp)}${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp,
			cwd: canonicalCwd,
		})}\n`;
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(body, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return { sessionId: sessionId(id), path, cwd: canonicalCwd, title, entries: [] };
	}

	async archive(session: SessionRecord, archivedAt: string): Promise<void> {
		await this.#assertOwnedSession(session);
		const previous = this.#archived.get(session.sessionId);
		this.#archived.set(session.sessionId, archivedAt);
		try {
			await this.#persist();
		} catch (error) {
			if (previous === undefined) this.#archived.delete(session.sessionId);
			else this.#archived.set(session.sessionId, previous);
			throw error;
		}
	}

	async restore(session: SessionRecord): Promise<void> {
		await this.#assertOwnedSession(session);
		const previous = this.#archived.get(session.sessionId);
		this.#archived.delete(session.sessionId);
		try {
			await this.#persist();
		} catch (error) {
			if (previous !== undefined) this.#archived.set(session.sessionId, previous);
			throw error;
		}
	}

	async delete(session: SessionRecord): Promise<void> {
		const path = await this.#assertOwnedSession(session);
		await unlink(path);
		const artifacts = path.slice(0, -".jsonl".length);
		try {
			const info = await lstat(artifacts);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("official OMP artifact root is unsafe");
			await rm(artifacts, { recursive: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.#archived.delete(session.sessionId);
		await this.#persist().catch(() => undefined);
	}

	async projectRootForProject(project: ProjectId): Promise<string> {
		const roots = new Set((await this.list()).filter(record => record.projectId === project).map(record => record.cwd));
		if (roots.size !== 1) throw new Error("official OMP project root is unavailable");
		return [...roots][0]!;
	}

	async projectRootForSession(id: SessionId): Promise<string> {
		const session = (await this.list()).find(record => record.sessionId === id);
		if (!session) throw new Error("official OMP session root is unavailable");
		return session.cwd;
	}

	lockStatus(): "missing" {
		return "missing";
	}

	async lockCheck(session: SessionRecord): Promise<void> {
		await this.#assertOwnedSession(session);
	}

	#assertInitialized(): void {
		if (!this.#initialized || !this.#canonicalRoot) throw new Error("official OMP authority is not initialized");
	}

	async #assertOwnedSession(session: SessionRecord): Promise<string> {
		this.#assertInitialized();
		if (!session.path.endsWith(".jsonl")) throw new Error("official OMP session path is invalid");
		const pathInfo = await lstat(session.path);
		if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error("official OMP session path is invalid");
		const canonical = await realpath(session.path);
		const child = relative(this.#canonicalRoot!, canonical);
		if (child === "" || child.startsWith("..") || isAbsolute(child))
			throw new Error("official OMP session is outside the exclusive root");
		return canonical;
	}

	async #assertOwnedDirectory(path: string): Promise<string> {
		this.#assertInitialized();
		const info = await lstat(path);
		const uid = process.getuid?.();
		if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid))
			throw new Error("official OMP session directory is unsafe");
		const canonical = await realpath(path);
		const child = relative(this.#canonicalRoot!, canonical);
		if (child === "" || child.startsWith("..") || isAbsolute(child))
			throw new Error("official OMP session directory is outside the exclusive root");
		await chmod(canonical, 0o700);
		return canonical;
	}

	async #persist(): Promise<void> {
		const metadata: OfficialProfileMetadata = { version: 1, archived: Object.fromEntries(this.#archived) };
		const body = `${JSON.stringify(metadata)}\n`;
		if (Buffer.byteLength(body, "utf8") > METADATA_BYTES) throw new Error("official OMP metadata exceeds 1 MiB");
		const temporary = `${this.#metadataPath}.${Bun.randomUUIDv7()}.tmp`;
		try {
			await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, this.#metadataPath);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
}
