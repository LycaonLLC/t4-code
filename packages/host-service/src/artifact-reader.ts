import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_MAX_BYTES, type ArtifactDescriptor, type ArtifactId } from "@t4-code/host-wire";

export class ArtifactReadError extends Error {
	constructor(
		readonly code: "artifact_invalid" | "artifact_not_found" | "connection_closed" | "session_not_attached",
		message: string,
	) {
		super(message);
	}
}

function sameFile(before: fs.Stats, after: fs.Stats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeMs === after.mtimeMs &&
		before.ctimeMs === after.ctimeMs
	);
}

const DIGEST_CACHE_LIMIT = 64;
const DIGEST_READ_BYTES = 64 * 1024;

function fileIdentity(info: fs.Stats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function aborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ArtifactReadError("connection_closed", "artifact read was cancelled");
}

/** Reads an already-authorized, session-local artifact in bounded chunks without exposing its path. */
export class ArtifactReader {
	readonly #verifiedDigests = new Map<string, undefined>();
	async read(
		root: string,
		descriptor: ArtifactDescriptor,
		offset: number,
		signal?: AbortSignal,
	): Promise<{
		artifactId: ArtifactId;
		kind: ArtifactDescriptor["kind"];
		mediaType: string;
		size: number;
		offset: number;
		nextOffset: number;
		complete: boolean;
		content: string;
	}> {
		if (!path.isAbsolute(root)) throw new ArtifactReadError("artifact_invalid", "artifact root must be absolute");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= ARTIFACT_MAX_BYTES)
			throw new ArtifactReadError("artifact_invalid", "artifact offset is invalid");
		aborted(signal);
		try {
			const uid = process.getuid?.();
			if (uid === undefined)
				throw new ArtifactReadError("artifact_invalid", "artifact owner checks are unavailable");
			const rootInfo = await fs.promises.lstat(root);
			if (
				rootInfo.isSymbolicLink() ||
				!rootInfo.isDirectory() ||
				rootInfo.uid !== uid ||
				(rootInfo.mode & 0o002) !== 0
			)
				throw new ArtifactReadError("artifact_invalid", "artifact root failed validation");
			const canonicalRoot = await fs.promises.realpath(root);
			const candidates = (await fs.promises.readdir(canonicalRoot)).filter(
				name => name.startsWith(`${descriptor.artifactId}.`) && /^[0-9]+\.[A-Za-z0-9_-]+\.log$/u.test(name),
			);
			if (candidates.length === 0) throw new ArtifactReadError("artifact_not_found", "artifact is unavailable");
			if (candidates.length !== 1 || (descriptor.name !== undefined && candidates[0] !== descriptor.name))
				throw new ArtifactReadError("artifact_invalid", "artifact file identity is ambiguous");
			const fileName = candidates[0]!;
			const handle = await fs.promises.open(
				path.join(canonicalRoot, fileName),
				fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
			);
			try {
				const before = await handle.stat();
				if (
					!before.isFile() ||
					before.uid !== uid ||
					(before.mode & 0o002) !== 0 ||
					before.size <= 0 ||
					before.size > ARTIFACT_MAX_BYTES ||
					(descriptor.size !== undefined && before.size !== descriptor.size)
				)
					throw new ArtifactReadError("artifact_invalid", "artifact file failed validation");
				if (offset >= before.size)
					throw new ArtifactReadError("artifact_invalid", "artifact offset exceeds its size");
				const nextOffset = Math.min(offset + ARTIFACT_CHUNK_BYTES, before.size);
				const data =
					descriptor.sha256 === undefined
						? await this.#readSlice(handle, before, offset, nextOffset, signal)
						: await this.#readVerifiedSlice(handle, before, offset, nextOffset, descriptor.sha256, signal);
				return {
					artifactId: descriptor.artifactId,
					kind: descriptor.kind,
					mediaType: descriptor.mediaType,
					size: before.size,
					offset,
					nextOffset,
					complete: nextOffset === before.size,
					content: data.toString("base64"),
				};
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (error instanceof ArtifactReadError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
				throw new ArtifactReadError("artifact_not_found", "artifact is unavailable");
			throw new ArtifactReadError("artifact_invalid", "artifact could not be read");
		}
	}
	async #readSlice(
		handle: fs.promises.FileHandle,
		before: fs.Stats,
		offset: number,
		nextOffset: number,
		signal: AbortSignal | undefined,
	): Promise<Buffer> {
		const data = Buffer.allocUnsafe(nextOffset - offset);
		aborted(signal);
		const { bytesRead } = await handle.read(data, 0, data.byteLength, offset);
		const after = await handle.stat();
		aborted(signal);
		if (bytesRead !== data.byteLength || !sameFile(before, after))
			throw new ArtifactReadError("artifact_invalid", "artifact changed while reading");
		return data;
	}

	async #readVerifiedSlice(
		handle: fs.promises.FileHandle,
		before: fs.Stats,
		offset: number,
		nextOffset: number,
		expectedDigest: string,
		signal: AbortSignal | undefined,
	): Promise<Buffer> {
		const key = `${expectedDigest}:${fileIdentity(before)}`;
		if (this.#verifiedDigests.has(key)) return this.#readSlice(handle, before, offset, nextOffset, signal);

		const data = Buffer.allocUnsafe(nextOffset - offset);
		const block = Buffer.allocUnsafe(Math.min(DIGEST_READ_BYTES, before.size));
		const hash = createHash("sha256");
		for (let position = 0; position < before.size; ) {
			aborted(signal);
			const length = Math.min(block.byteLength, before.size - position);
			const { bytesRead } = await handle.read(block, 0, length, position);
			if (bytesRead !== length) throw new ArtifactReadError("artifact_invalid", "artifact changed while reading");
			hash.update(block.subarray(0, bytesRead));
			const copyStart = Math.max(position, offset);
			const copyEnd = Math.min(position + bytesRead, nextOffset);
			if (copyStart < copyEnd)
				block.copy(data, copyStart - offset, copyStart - position, copyEnd - position);
			position += bytesRead;
		}
		const after = await handle.stat();
		aborted(signal);
		if (!sameFile(before, after)) throw new ArtifactReadError("artifact_invalid", "artifact changed while reading");
		if (hash.digest("hex") !== expectedDigest)
			throw new ArtifactReadError("artifact_invalid", "artifact digest does not match its descriptor");
		this.#rememberDigest(key);
		return data;
	}

	#rememberDigest(key: string): void {
		this.#verifiedDigests.delete(key);
		this.#verifiedDigests.set(key, undefined);
		if (this.#verifiedDigests.size > DIGEST_CACHE_LIMIT) this.#verifiedDigests.delete(this.#verifiedDigests.keys().next().value!);
	}
}
