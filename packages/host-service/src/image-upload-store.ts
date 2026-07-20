import { createHash, type Hash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	IMAGE_UPLOAD_MAX_BYTES,
	type ImageId,
	imageId,
	PROMPT_IMAGE_MAX_COUNT,
	type PromptImageMimeType,
	type SessionId,
} from "@t4-code/host-wire";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_CONNECTION_BYTES = PROMPT_IMAGE_MAX_COUNT * IMAGE_UPLOAD_MAX_BYTES;
const DEFAULT_GLOBAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_GLOBAL_UPLOADS = 64;

export class ImageUploadError extends Error {
	constructor(
		readonly code:
			| "connection_closed"
			| "image_conflict"
			| "image_incomplete"
			| "image_invalid"
			| "image_not_found"
			| "image_quota_exceeded",
		message: string,
	) {
		super(message);
		this.name = "ImageUploadError";
	}
}

export interface ManagedRpcImageRef {
	readonly imageId: ImageId;
	readonly mimeType: PromptImageMimeType;
	readonly size: number;
	readonly sha256: string;
}

interface UploadRecord extends ManagedRpcImageRef {
	readonly connectionId: string;
	readonly sessionId: SessionId;
	readonly filePath: string;
	readonly handle: fs.FileHandle;
	readonly hasher: Hash;
	received: number;
	updatedAt: number;
	prefix: Uint8Array;
	complete: boolean;
	consumed: boolean;
	cleanupPending: boolean;
}

interface Reservation {
	bytes: number;
	uploads: number;
}

export interface ImageUploadStoreOptions {
	readonly root: string;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly sweepIntervalMs?: number;
	readonly maxConnectionBytes?: number;
	readonly maxConnectionUploads?: number;
	readonly maxGlobalBytes?: number;
	readonly maxGlobalUploads?: number;
	/** Contract-test seam; production removes spool files with fs.unlink. */
	readonly unlink?: (filePath: string) => Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}

function sniffMimeType(prefix: Uint8Array): PromptImageMimeType | undefined {
	if (
		prefix.length >= 8 &&
		prefix[0] === 0x89 &&
		prefix[1] === 0x50 &&
		prefix[2] === 0x4e &&
		prefix[3] === 0x47 &&
		prefix[4] === 0x0d &&
		prefix[5] === 0x0a &&
		prefix[6] === 0x1a &&
		prefix[7] === 0x0a
	)
		return "image/png";
	if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "image/jpeg";
	const signature = new TextDecoder().decode(prefix);
	if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
	if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

export class ImageUploadStore {
	readonly root: string;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #sweepIntervalMs: number;
	readonly #maxConnectionBytes: number;
	readonly #maxConnectionUploads: number;
	readonly #maxGlobalBytes: number;
	readonly #maxGlobalUploads: number;
	readonly #unlink: (filePath: string) => Promise<void>;
	readonly #uploads = new Map<ImageId, UploadRecord>();
	readonly #reservations = new Map<string, Reservation>();
	#globalBytes = 0;
	#timer: NodeJS.Timeout | undefined;
	#started = false;
	#tail: Promise<void> = Promise.resolve();

	constructor(options: ImageUploadStoreOptions) {
		if (!path.isAbsolute(options.root)) throw new Error("image upload root must be absolute");
		this.root = options.root;
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
		this.#maxConnectionBytes = options.maxConnectionBytes ?? DEFAULT_CONNECTION_BYTES;
		this.#maxConnectionUploads = options.maxConnectionUploads ?? PROMPT_IMAGE_MAX_COUNT;
		this.#maxGlobalBytes = options.maxGlobalBytes ?? DEFAULT_GLOBAL_BYTES;
		this.#maxGlobalUploads = options.maxGlobalUploads ?? DEFAULT_GLOBAL_UPLOADS;
		this.#unlink = options.unlink ?? fs.unlink;
		for (const [name, value] of Object.entries({
			ttlMs: this.#ttlMs,
			sweepIntervalMs: this.#sweepIntervalMs,
			maxConnectionBytes: this.#maxConnectionBytes,
			maxConnectionUploads: this.#maxConnectionUploads,
			maxGlobalBytes: this.#maxGlobalBytes,
			maxGlobalUploads: this.#maxGlobalUploads,
		}))
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	}

	async start(): Promise<void> {
		await this.#run(async () => {
			if (this.#started) return;
			await fs.rm(this.root, { recursive: true, force: true });
			await fs.mkdir(this.root, { mode: 0o700 });
			await fs.chmod(this.root, 0o700);
			this.#started = true;
			this.#timer = setInterval(() => void this.sweepExpired().catch(() => undefined), this.#sweepIntervalMs);
			this.#timer.unref();
		});
	}

	async stop(): Promise<void> {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		await this.#run(async () => {
			for (const record of this.#uploads.values()) await this.#remove(record).catch(() => undefined);
			this.#uploads.clear();
			this.#reservations.clear();
			this.#globalBytes = 0;
			this.#started = false;
			await fs.rm(this.root, { recursive: true, force: true });
		});
	}

	async begin(input: {
		connectionId: string;
		sessionId: SessionId;
		mimeType: PromptImageMimeType;
		size: number;
		sha256: string;
	}): Promise<{ imageId: ImageId }> {
		return this.#run(async () => {
			this.#assertStarted();
			await this.#sweepExpiredLocked();
			const reserved = this.#reservations.get(input.connectionId) ?? { bytes: 0, uploads: 0 };
			if (
				reserved.uploads >= this.#maxConnectionUploads ||
				reserved.bytes + input.size > this.#maxConnectionBytes ||
				this.#uploads.size >= this.#maxGlobalUploads ||
				this.#globalBytes + input.size > this.#maxGlobalBytes
			)
				throw new ImageUploadError("image_quota_exceeded", "image upload quota exceeded");
			const id = imageId(randomUUID());
			const filePath = path.join(this.root, id);
			const handle = await fs.open(filePath, "wx+", 0o600);
			try {
				await handle.chmod(0o600);
				const record: UploadRecord = {
					imageId: id,
					connectionId: input.connectionId,
					sessionId: input.sessionId,
					mimeType: input.mimeType,
					size: input.size,
					sha256: input.sha256,
					filePath,
					handle,
					hasher: createHash("sha256"),
					received: 0,
					updatedAt: this.#now(),
					prefix: new Uint8Array(),
					complete: false,
					consumed: false,
					cleanupPending: false,
				};
				this.#uploads.set(id, record);
				this.#reservations.set(input.connectionId, {
					bytes: reserved.bytes + input.size,
					uploads: reserved.uploads + 1,
				});
				this.#globalBytes += input.size;
				return { imageId: id };
			} catch (error) {
				await handle.close().catch(() => undefined);
				await fs.unlink(filePath).catch(() => undefined);
				throw error;
			}
		});
	}

	async chunk(input: {
		connectionId: string;
		sessionId: SessionId;
		imageId: ImageId;
		offset: number;
		data: Uint8Array;
	}): Promise<{ imageId: ImageId; received: number; complete: boolean }> {
		return this.#run(async () => {
			this.#assertStarted();
			await this.#sweepExpiredLocked();
			const record = this.#owned(input.connectionId, input.sessionId, input.imageId);
			const end = input.offset + input.data.byteLength;
			if (end > record.size) throw new ImageUploadError("image_invalid", "image chunk exceeds declared size");
			if (input.offset > record.received)
				throw new ImageUploadError("image_conflict", "image chunk offset has a gap");
			if (input.offset < record.received) {
				if (end > record.received)
					throw new ImageUploadError("image_conflict", "image chunk overlaps bytes not yet committed");
				const existing = new Uint8Array(input.data.byteLength);
				const read = await record.handle.read(existing, 0, existing.byteLength, input.offset);
				if (
					read.bytesRead !== input.data.byteLength ||
					!existing.every((value, index) => value === input.data[index])
				)
					throw new ImageUploadError("image_conflict", "image chunk retry does not match committed bytes");
				record.updatedAt = this.#now();
				return { imageId: record.imageId, received: record.received, complete: record.complete };
			}
			if (record.complete) throw new ImageUploadError("image_conflict", "image upload is already complete");
			const written = await record.handle.write(input.data, 0, input.data.byteLength, input.offset);
			if (written.bytesWritten !== input.data.byteLength)
				throw new ImageUploadError("image_invalid", "image chunk could not be fully written");
			record.hasher.update(input.data);
			if (record.prefix.byteLength < 12) {
				const prefix = new Uint8Array(Math.min(12, record.prefix.byteLength + input.data.byteLength));
				prefix.set(record.prefix);
				prefix.set(input.data.subarray(0, prefix.byteLength - record.prefix.byteLength), record.prefix.byteLength);
				record.prefix = prefix;
			}
			record.received = end;
			record.updatedAt = this.#now();
			if (end === record.size) {
				await record.handle.sync();
				const hash = record.hasher.digest("hex");
				if (hash !== record.sha256 || sniffMimeType(record.prefix) !== record.mimeType) {
					await this.#remove(record).catch(() => undefined);
					throw new ImageUploadError("image_invalid", "image content does not match its declaration");
				}
				record.complete = true;
			}
			return { imageId: record.imageId, received: record.received, complete: record.complete };
		});
	}

	async consume(
		connectionId: string,
		sessionId: SessionId,
		refs: readonly { imageId: ImageId }[],
	): Promise<ManagedRpcImageRef[]> {
		return this.#run(async () => {
			this.#assertStarted();
			await this.#sweepExpiredLocked();
			if (refs.length === 0 || refs.length > PROMPT_IMAGE_MAX_COUNT)
				throw new ImageUploadError("image_invalid", "prompt image count is invalid");
			const seen = new Set<ImageId>();
			const records = refs.map(ref => {
				if (seen.has(ref.imageId))
					throw new ImageUploadError("image_conflict", "prompt image references must be unique");
				seen.add(ref.imageId);
				const record = this.#owned(connectionId, sessionId, ref.imageId);
				if (!record.complete) throw new ImageUploadError("image_incomplete", "image upload is incomplete");
				return record;
			});
			for (const record of records) {
				await record.handle.close().catch(() => undefined);
				record.consumed = true;
			}
			return records.map(record => ({
				imageId: record.imageId,
				mimeType: record.mimeType,
				size: record.size,
				sha256: record.sha256,
			}));
		});
	}

	async discard(connectionId: string, sessionId: SessionId, id: ImageId): Promise<boolean> {
		return this.#run(async () => {
			this.#assertStarted();
			await this.#sweepExpiredLocked();
			const record = this.#uploads.get(id);
			if (!record || record.consumed || record.connectionId !== connectionId || record.sessionId !== sessionId)
				return false;
			await this.#remove(record);
			return true;
		});
	}

	async release(refs: readonly ManagedRpcImageRef[]): Promise<void> {
		await this.#run(async () => {
			for (const ref of refs) {
				const record = this.#uploads.get(ref.imageId);
				// Cleanup follows the child acknowledgement but is not the prompt
				// outcome. A transient unlink failure must never turn an accepted,
				// side-effecting prompt into outcome_unknown; the sweeper retries it.
				if (record?.consumed) {
					record.cleanupPending = true;
					await this.#remove(record).catch(() => undefined);
				}
			}
		});
	}

	async cleanupConnection(connectionId: string): Promise<void> {
		await this.#run(async () => {
			for (const record of this.#uploads.values())
				if (record.connectionId === connectionId && !record.consumed)
					await this.#remove(record).catch(() => undefined);
		});
	}

	async cleanupSession(sessionId: SessionId): Promise<void> {
		await this.#run(async () => {
			for (const record of this.#uploads.values())
				if (record.sessionId === sessionId && !record.consumed) await this.#remove(record).catch(() => undefined);
		});
	}

	async sweepExpired(): Promise<void> {
		await this.#run(() => this.#sweepExpiredLocked());
	}

	#owned(connectionId: string, sessionId: SessionId, id: ImageId): UploadRecord {
		const record = this.#uploads.get(id);
		if (
			!record ||
			record.consumed ||
			record.cleanupPending ||
			record.connectionId !== connectionId ||
			record.sessionId !== sessionId
		)
			throw new ImageUploadError("image_not_found", "image upload is unavailable for this connection and session");
		return record;
	}

	async #sweepExpiredLocked(): Promise<void> {
		const cutoff = this.#now() - this.#ttlMs;
		for (const record of this.#uploads.values())
			if (record.cleanupPending || (!record.consumed && record.updatedAt <= cutoff))
				await this.#remove(record).catch(() => undefined);
	}

	async #remove(record: UploadRecord): Promise<void> {
		if (this.#uploads.get(record.imageId) !== record) return;
		await record.handle.close().catch(() => undefined);
		try {
			await this.#unlink(record.filePath);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) {
				record.cleanupPending = true;
				throw error;
			}
		}
		this.#detach(record);
	}

	#detach(record: UploadRecord): void {
		if (!this.#uploads.delete(record.imageId)) return;
		const reserved = this.#reservations.get(record.connectionId);
		if (reserved) {
			reserved.bytes -= record.size;
			reserved.uploads -= 1;
			if (reserved.uploads === 0) this.#reservations.delete(record.connectionId);
		}
		this.#globalBytes -= record.size;
	}

	#assertStarted(): void {
		if (!this.#started) throw new Error("image upload store is not started");
	}

	#run<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.#tail.then(operation, operation);
		this.#tail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
}
