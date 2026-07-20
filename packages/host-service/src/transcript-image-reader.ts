import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	TRANSCRIPT_IMAGE_CHUNK_BYTES,
	TRANSCRIPT_IMAGE_MAX_BYTES,
	type TranscriptImageMimeType,
} from "@t4-code/host-wire";

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_ENTRIES = 32;

interface CachedImage {
	readonly data: Buffer;
	readonly mimeType: TranscriptImageMimeType;
}

export class TranscriptImageError extends Error {
	constructor(
		readonly code: "connection_closed" | "image_invalid" | "image_not_found" | "session_not_attached",
		message: string,
	) {
		super(message);
		this.name = "TranscriptImageError";
	}
}

export interface TranscriptImageReaderOptions {
	readonly root: string;
	readonly maxCacheBytes?: number;
	readonly maxCacheEntries?: number;
}

function sniffMimeType(data: Uint8Array): TranscriptImageMimeType | undefined {
	if (
		data.length >= 8 &&
		data[0] === 0x89 &&
		data[1] === 0x50 &&
		data[2] === 0x4e &&
		data[3] === 0x47 &&
		data[4] === 0x0d &&
		data[5] === 0x0a &&
		data[6] === 0x1a &&
		data[7] === 0x0a
	)
		return "image/png";
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	const signature = new TextDecoder().decode(data.subarray(0, 12));
	if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
	if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
	return undefined;
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

function aborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new TranscriptImageError("connection_closed", "transcript image read was cancelled");
}

/** Reads immutable, content-addressed transcript images without exposing local paths. */
export class TranscriptImageReader {
	readonly root: string;
	readonly #maxCacheBytes: number;
	readonly #maxCacheEntries: number;
	readonly #cache = new Map<string, CachedImage>();
	#cacheBytes = 0;

	constructor(options: TranscriptImageReaderOptions) {
		if (!path.isAbsolute(options.root)) throw new Error("transcript image root must be absolute");
		this.root = path.resolve(options.root);
		this.#maxCacheBytes = options.maxCacheBytes ?? DEFAULT_CACHE_BYTES;
		this.#maxCacheEntries = options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES;
		for (const [name, value] of Object.entries({
			maxCacheBytes: this.#maxCacheBytes,
			maxCacheEntries: this.#maxCacheEntries,
		}))
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	}

	clear(): void {
		this.#cache.clear();
		this.#cacheBytes = 0;
	}

	async read(
		sha256: string,
		mimeType: TranscriptImageMimeType,
		offset: number,
		signal?: AbortSignal,
	): Promise<{
		sha256: string;
		mimeType: TranscriptImageMimeType;
		size: number;
		offset: number;
		nextOffset: number;
		complete: boolean;
		content: string;
	}> {
		if (!/^[a-f0-9]{64}$/u.test(sha256))
			throw new TranscriptImageError("image_invalid", "transcript image digest is invalid");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= TRANSCRIPT_IMAGE_MAX_BYTES)
			throw new TranscriptImageError("image_invalid", "transcript image offset is invalid");
		aborted(signal);
		const image = this.#fromCache(sha256) ?? (await this.#load(sha256, mimeType, signal));
		if (image.mimeType !== mimeType)
			throw new TranscriptImageError("image_invalid", "transcript image MIME type does not match its metadata");
		if (offset >= image.data.byteLength)
			throw new TranscriptImageError("image_invalid", "transcript image offset exceeds its size");
		aborted(signal);
		const nextOffset = Math.min(offset + TRANSCRIPT_IMAGE_CHUNK_BYTES, image.data.byteLength);
		return {
			sha256,
			mimeType,
			size: image.data.byteLength,
			offset,
			nextOffset,
			complete: nextOffset === image.data.byteLength,
			content: image.data.subarray(offset, nextOffset).toString("base64"),
		};
	}

	#fromCache(sha256: string): CachedImage | undefined {
		const image = this.#cache.get(sha256);
		if (!image) return undefined;
		this.#cache.delete(sha256);
		this.#cache.set(sha256, image);
		return image;
	}

	#remember(sha256: string, image: CachedImage): void {
		if (image.data.byteLength > this.#maxCacheBytes) return;
		const previous = this.#cache.get(sha256);
		if (previous) {
			this.#cacheBytes -= previous.data.byteLength;
			this.#cache.delete(sha256);
		}
		this.#cache.set(sha256, image);
		this.#cacheBytes += image.data.byteLength;
		while (this.#cacheBytes > this.#maxCacheBytes || this.#cache.size > this.#maxCacheEntries) {
			const oldest = this.#cache.entries().next().value as [string, CachedImage] | undefined;
			if (!oldest) break;
			this.#cache.delete(oldest[0]);
			this.#cacheBytes -= oldest[1].data.byteLength;
		}
	}

	async #load(
		sha256: string,
		mimeType: TranscriptImageMimeType,
		signal: AbortSignal | undefined,
	): Promise<CachedImage> {
		try {
			const uid = process.getuid?.();
			if (uid === undefined)
				throw new TranscriptImageError("image_invalid", "transcript image owner checks are unavailable");
			const rootInfo = await fs.promises.lstat(this.root);
			if (
				rootInfo.isSymbolicLink() ||
				!rootInfo.isDirectory() ||
				rootInfo.uid !== uid ||
				(rootInfo.mode & 0o002) !== 0
			)
				throw new TranscriptImageError("image_invalid", "transcript image root failed validation");
			const canonicalRoot = await fs.promises.realpath(this.root);
			aborted(signal);
			const handle = await fs.promises.open(
				path.join(canonicalRoot, sha256),
				fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
			);
			try {
				const before = await handle.stat();
				if (
					!before.isFile() ||
					before.uid !== uid ||
					(before.mode & 0o002) !== 0 ||
					before.size <= 0 ||
					before.size > TRANSCRIPT_IMAGE_MAX_BYTES
				)
					throw new TranscriptImageError("image_invalid", "transcript image file failed validation");
				aborted(signal);
				const data = await handle.readFile();
				const after = await handle.stat();
				aborted(signal);
				if (data.byteLength !== before.size || !sameFile(before, after))
					throw new TranscriptImageError("image_invalid", "transcript image changed while reading");
				if (createHash("sha256").update(data).digest("hex") !== sha256)
					throw new TranscriptImageError("image_invalid", "transcript image failed digest validation");
				if (sniffMimeType(data) !== mimeType)
					throw new TranscriptImageError("image_invalid", "transcript image failed MIME validation");
				const image = { data, mimeType };
				this.#remember(sha256, image);
				return image;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (error instanceof TranscriptImageError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR")
				throw new TranscriptImageError("image_not_found", "transcript image is unavailable");
			throw new TranscriptImageError("image_invalid", "transcript image could not be read");
		}
	}
}
