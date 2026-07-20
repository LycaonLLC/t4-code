import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, readFile, readlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface OwnerRecord {
	version: 2;
	ownerId: string;
	pid: number;
	backingName: string;
	device: number;
	inode: number;
}

export interface OwnerPaths {
	directory: string;
	ownerPath: string;
	backingPath: string;
	backingName: string;
	publicPath: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function decodeOwnerRecord(value: unknown): OwnerRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed appserver owner record");
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["backingName", "device", "inode", "ownerId", "pid", "version"]))
		throw new Error("malformed appserver owner record");
	if (
		record.version !== 2 ||
		typeof record.ownerId !== "string" ||
		!UUID.test(record.ownerId) ||
		!validInteger(record.pid, 1) ||
		typeof record.backingName !== "string" ||
		!UUID.test(record.backingName.slice(".appserver-".length, -".sock".length)) ||
		record.backingName !== `.appserver-${record.ownerId}.sock` ||
		!validInteger(record.device, 0) ||
		!validInteger(record.inode, 0)
	)
		throw new Error("malformed appserver owner record");
	return {
		version: 2,
		ownerId: record.ownerId,
		pid: record.pid,
		backingName: record.backingName,
		device: record.device,
		inode: record.inode,
	};
}

export function ownerPaths(publicPath: string, ownerId: string): OwnerPaths {
	const directory = dirname(publicPath);
	const backingName = `.appserver-${ownerId}.sock`;
	return {
		directory,
		ownerPath: `${publicPath}.owner`,
		backingPath: join(directory, backingName),
		backingName,
		publicPath,
	};
}

export function sameIdentity(
	a: Pick<OwnerRecord, "device" | "inode">,
	b: Pick<OwnerRecord, "device" | "inode">,
): boolean {
	return a.device === b.device && a.inode === b.inode;
}

const DARWIN_SYSTEM_ALIASES = [
	{ alias: "/tmp", target: "/private/tmp" },
	{ alias: "/var", target: "/private/var" },
] as const;
const PROTECTED_SOCKET_DIRECTORIES: Readonly<Record<string, true>> = Object.freeze({
	"/": true,
	"/tmp": true,
	"/var": true,
	"/private/tmp": true,
	"/private/var": true,
});

async function normalizeDarwinSystemAlias(directory: string): Promise<string> {
	if (process.platform !== "darwin") return directory;
	for (const { alias, target } of DARWIN_SYSTEM_ALIASES) {
		if (directory !== alias && !directory.startsWith(`${alias}${sep}`)) continue;
		const info = await lstat(alias);
		if (!info.isSymbolicLink()) return directory;
		const aliasTarget = resolve(dirname(alias), await readlink(alias));
		if (aliasTarget !== target) return directory;
		return join(target, relative(alias, directory));
	}
	return directory;
}

export async function ensureSecureSocketDirectory(publicPath: string): Promise<string> {
	const directory = await normalizeDarwinSystemAlias(resolve(dirname(publicPath)));
	if (PROTECTED_SOCKET_DIRECTORIES[directory] === true)
		throw new Error(`appserver socket directory must not be a shared system directory: ${directory}`);
	const parts = directory.split(sep).filter(Boolean);
	let current = directory.startsWith(sep) ? sep : "";
	for (const part of parts) {
		current = current ? join(current, part) : part;
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new Error(`appserver socket directory is a symlink: ${current}`);
			if (!info.isDirectory()) throw new Error(`appserver socket directory is not a directory: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`appserver socket directory is not a secure directory: ${directory}`);
	await chmod(directory, 0o700);
	return directory;
}

export async function readStrictOwner(ownerPath: string): Promise<{ record: OwnerRecord; stat: Stats }> {
	const first = await lstat(ownerPath);
	if (first.isSymbolicLink() || !first.isFile() || (first.mode & 0o777) !== 0o600)
		throw new Error("malformed appserver owner marker");
	const text = await readFile(ownerPath, "utf8");
	const second = await lstat(ownerPath);
	if (first.dev !== second.dev || first.ino !== second.ino)
		throw new Error("appserver owner marker changed during read");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("malformed appserver owner marker");
	}
	return { record: decodeOwnerRecord(parsed), stat: first };
}

export async function readPublicTarget(
	publicPath: string,
): Promise<{ stat: { device: number; inode: number }; target: string }> {
	const info = await lstat(publicPath);
	if (!info.isSymbolicLink()) throw new Error("appserver public path is not an owned symlink");
	const target = await readlink(publicPath);
	if (
		isAbsolute(target) ||
		target.includes("/") ||
		target.includes("\\") ||
		target === "." ||
		target === ".." ||
		relative(dirname(publicPath), resolve(dirname(publicPath), target)) !== target
	)
		throw new Error("appserver public symlink target is unsafe");
	return { stat: { device: Number(info.dev), inode: Number(info.ino) }, target };
}

export async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function markerIdentity(handle: FileHandle): Promise<{ device: number; inode: number }> {
	const info = await handle.stat();
	return { device: Number(info.dev), inode: Number(info.ino) };
}
