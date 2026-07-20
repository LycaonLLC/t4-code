import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { imageId, sessionId } from "@t4-code/host-wire";
import { ImageUploadStore, type ImageUploadStoreOptions } from "../src/image-upload-store.ts";

const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function testStore(options: Omit<ImageUploadStoreOptions, "root"> = {}) {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-store-"));
	const root = path.join(parent, "images");
	const store = new ImageUploadStore({ root, sweepIntervalMs: 60_000, ...options });
	await store.start();
	return { parent, root, store };
}

describe("managed appserver image uploads", () => {
	test("spools privately, supports idempotent chunks, and releases only after consumption acknowledgement", async () => {
		const { parent, root, store } = await testStore();
		try {
			expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
			const started = await store.begin({
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png",
				size: png.byteLength,
				sha256: digest(png),
			});
			expect((await fs.stat(path.join(root, started.imageId))).mode & 0o777).toBe(0o600);

			expect(
				await store.chunk({
					connectionId: "connection-a",
					sessionId: sessionId("session-a"),
					imageId: started.imageId,
					offset: 0,
					data: png.subarray(0, 4),
				}),
			).toMatchObject({ received: 4, complete: false });
			expect(
				await store.chunk({
					connectionId: "connection-a",
					sessionId: sessionId("session-a"),
					imageId: started.imageId,
					offset: 0,
					data: png.subarray(0, 4),
				}),
			).toMatchObject({ received: 4, complete: false });
			await expect(
				store.chunk({
					connectionId: "connection-a",
					sessionId: sessionId("session-a"),
					imageId: started.imageId,
					offset: 0,
					data: Uint8Array.of(0, 0, 0, 0),
				}),
			).rejects.toMatchObject({ code: "image_conflict" });
			await expect(
				store.chunk({
					connectionId: "connection-a",
					sessionId: sessionId("session-a"),
					imageId: started.imageId,
					offset: 5,
					data: Uint8Array.of(1),
				}),
			).rejects.toMatchObject({ code: "image_conflict" });
			expect(
				await store.chunk({
					connectionId: "connection-a",
					sessionId: sessionId("session-a"),
					imageId: started.imageId,
					offset: 4,
					data: png.subarray(4),
				}),
			).toMatchObject({ received: png.byteLength, complete: true });

			await expect(
				store.consume("connection-b", sessionId("session-a"), [{ imageId: started.imageId }]),
			).rejects.toMatchObject({ code: "image_not_found" });
			const refs = await store.consume("connection-a", sessionId("session-a"), [{ imageId: started.imageId }]);
			expect(refs).toEqual([
				{
					imageId: started.imageId,
					mimeType: "image/png",
					size: png.byteLength,
					sha256: digest(png),
				},
			]);
			await store.cleanupConnection("connection-a");
			await store.cleanupSession(sessionId("session-a"));
			expect(await store.discard("connection-a", sessionId("session-a"), started.imageId)).toBe(false);
			expect(await fs.readFile(path.join(root, started.imageId))).toEqual(Buffer.from(png));
			await expect(
				store.consume("connection-a", sessionId("session-a"), [{ imageId: started.imageId }]),
			).rejects.toMatchObject({ code: "image_not_found" });
			await store.release(refs);
			await expect(fs.stat(path.join(root, started.imageId))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await store.stop();
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("owner-scoped discard recovers quota after a partial multi-image upload", async () => {
		const { parent, store } = await testStore({
			maxConnectionBytes: png.byteLength * 2,
			maxConnectionUploads: 2,
			maxGlobalBytes: png.byteLength * 4,
			maxGlobalUploads: 4,
		});
		try {
			const input = {
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			const first = await store.begin(input);
			await store.chunk({
				connectionId: input.connectionId,
				sessionId: input.sessionId,
				imageId: first.imageId,
				offset: 0,
				data: png.subarray(0, 4),
			});
			const second = await store.begin(input);
			await expect(store.begin(input)).rejects.toMatchObject({ code: "image_quota_exceeded" });

			expect(await store.discard("connection-b", sessionId("session-a"), first.imageId)).toBe(false);
			expect(await store.discard("connection-a", sessionId("session-b"), first.imageId)).toBe(false);
			expect(
				await store.discard(
					"connection-a",
					sessionId("session-a"),
					imageId("123e4567-e89b-42d3-a456-426614174000"),
				),
			).toBe(false);
			await expect(store.begin(input)).rejects.toMatchObject({ code: "image_quota_exceeded" });

			expect(await store.discard("connection-a", sessionId("session-a"), first.imageId)).toBe(true);
			expect(await store.discard("connection-a", sessionId("session-a"), first.imageId)).toBe(false);
			expect(await store.discard("connection-a", sessionId("session-a"), second.imageId)).toBe(true);
			expect(await store.begin(input)).toHaveProperty("imageId");
			expect(await store.begin(input)).toHaveProperty("imageId");
		} finally {
			await store.stop();
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("keeps consumed uploads reserved until delayed child acknowledgement", async () => {
		const { parent, root, store } = await testStore({
			maxConnectionBytes: png.byteLength,
			maxConnectionUploads: 1,
			maxGlobalBytes: png.byteLength,
			maxGlobalUploads: 1,
		});
		try {
			const first = await store.begin({
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png",
				size: png.byteLength,
				sha256: digest(png),
			});
			await store.chunk({
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				imageId: first.imageId,
				offset: 0,
				data: png,
			});
			const inFlight = await store.consume("connection-a", sessionId("session-a"), [{ imageId: first.imageId }]);
			const secondInput = {
				connectionId: "connection-b",
				sessionId: sessionId("session-b"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			await store.sweepExpired();
			expect(await fs.readFile(path.join(root, first.imageId))).toEqual(Buffer.from(png));
			await expect(store.begin(secondInput)).rejects.toMatchObject({ code: "image_quota_exceeded" });
			await store.release(inFlight);
			const second = await store.begin(secondInput);
			expect(second.imageId).not.toBe(first.imageId);
		} finally {
			await store.stop();
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("retries lifecycle cleanup failures without blocking teardown", async () => {
		let failUnlink = true;
		const { parent, root, store } = await testStore({
			maxConnectionBytes: png.byteLength,
			maxConnectionUploads: 1,
			maxGlobalBytes: png.byteLength,
			maxGlobalUploads: 1,
			unlink: async filePath => {
				if (failUnlink) {
					const error = new Error("transient unlink failure") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				await fs.unlink(filePath);
			},
		});
		try {
			const input = {
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			const started = await store.begin(input);

			await expect(store.cleanupConnection(input.connectionId)).resolves.toBeUndefined();
			expect((await fs.readdir(root)).filter(name => name.startsWith(".delete-"))).toHaveLength(1);
			await expect(
				store.chunk({
					connectionId: input.connectionId,
					sessionId: input.sessionId,
					imageId: started.imageId,
					offset: 0,
					data: png,
				}),
			).rejects.toMatchObject({ code: "image_not_found" });
			await expect(store.begin(input)).rejects.toMatchObject({ code: "image_quota_exceeded" });

			failUnlink = false;
			await store.sweepExpired();
			expect((await fs.readdir(root)).filter(name => name.startsWith(".delete-"))).toHaveLength(0);
			expect(await store.begin(input)).toHaveProperty("imageId");
		} finally {
			await store.stop();
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("retries post-ack cleanup without changing the accepted prompt boundary", async () => {
		let failUnlink = true;
		const { parent, root, store } = await testStore({
			maxConnectionBytes: png.byteLength,
			maxConnectionUploads: 1,
			maxGlobalBytes: png.byteLength,
			maxGlobalUploads: 1,
			unlink: async filePath => {
				if (failUnlink) {
					const error = new Error("transient unlink failure") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				await fs.unlink(filePath);
			},
		});
		try {
			const input = {
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			const started = await store.begin(input);
			await store.chunk({ ...input, imageId: started.imageId, offset: 0, data: png });
			const acknowledged = await store.consume(input.connectionId, input.sessionId, [{ imageId: started.imageId }]);

			// Child success is already authoritative. Release absorbs the cleanup
			// failure while retaining its reservation for a safe retry.
			await expect(store.release(acknowledged)).resolves.toBeUndefined();
			await expect(store.begin(input)).rejects.toMatchObject({ code: "image_quota_exceeded" });
			expect((await fs.readdir(root)).filter(name => name.startsWith(".delete-"))).toHaveLength(1);

			failUnlink = false;
			await store.sweepExpired();
			expect((await fs.readdir(root)).filter(name => name.startsWith(".delete-"))).toHaveLength(0);
			expect(await store.begin(input)).toHaveProperty("imageId");
		} finally {
			await store.stop();
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("rejects content mismatches and expires only unconsumed uploads", async () => {
		let now = 1_000;
		const { parent, root, store } = await testStore({ now: () => now, ttlMs: 100 });
		try {
			const invalid = await store.begin({
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/jpeg",
				size: png.byteLength,
				sha256: digest(png),
			});
			await expect(
				store.chunk({
					connectionId: "connection-a",
					sessionId: sessionId("session-a"),
					imageId: invalid.imageId,
					offset: 0,
					data: png,
				}),
			).rejects.toMatchObject({ code: "image_invalid" });
			await expect(fs.stat(path.join(root, invalid.imageId))).rejects.toMatchObject({ code: "ENOENT" });

			const expiring = await store.begin({
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png",
				size: png.byteLength,
				sha256: digest(png),
			});
			now += 100;
			await store.sweepExpired();
			await expect(fs.stat(path.join(root, expiring.imageId))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await store.stop();
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("claims an empty private preexisting root", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-store-empty-"));
		const root = path.join(parent, "images");
		await fs.mkdir(root, { mode: 0o700 });
		const store = new ImageUploadStore({ root, sweepIntervalMs: 60_000 });
		try {
			await store.start();
			expect(await fs.readdir(root)).toEqual([".t4-image-upload-store"]);
			await store.stop();
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("repairs an interrupted marker when no unrelated data is present", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-store-marker-"));
		const root = path.join(parent, "images");
		await fs.mkdir(root, { mode: 0o700 });
		await fs.writeFile(path.join(root, ".t4-image-upload-store"), "partial", { mode: 0o600 });
		const store = new ImageUploadStore({ root, sweepIntervalMs: 60_000 });
		try {
			await store.start();
			expect(await fs.readFile(path.join(root, ".t4-image-upload-store"), "utf8")).toBe(
				"t4-image-upload-store-v1\n",
			);
			await store.stop();
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("refuses unproven preexisting roots without deleting their contents", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-store-unproven-"));
		const root = path.join(parent, "images");
		const sentinel = path.join(root, "sentinel");
		await fs.mkdir(root, { mode: 0o700 });
		await fs.writeFile(sentinel, "preserve me");
		try {
			const store = new ImageUploadStore({ root, sweepIntervalMs: 60_000 });
			await expect(store.start()).rejects.toThrow();
			expect(await fs.readFile(sentinel, "utf8")).toBe("preserve me");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("recovers only stale files from a valid owned spool", async () => {
		const { parent, root, store } = await testStore();
		const stale = path.join(root, "4e2e669a-5f8e-44a3-b702-e725c4c106c8");
		const interrupted = path.join(root, ".delete-7c4476e9-b9e3-471c-8b2b-2a9f3e86bd2f");
		const markerTemp = path.join(
			root,
			".t4-image-upload-store.1d816c9f-2aba-448f-a38b-4c537f99760f.tmp",
		);
		try {
			await store.stop();
			await fs.writeFile(stale, "stale");
			await fs.writeFile(interrupted, "interrupted");
			await fs.writeFile(markerTemp, "partial marker");
			const recovered = new ImageUploadStore({ root, sweepIntervalMs: 60_000 });
			await recovered.start();
			await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(interrupted)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(markerTemp)).rejects.toMatchObject({ code: "ENOENT" });
			await recovered.stop();
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("does not remove a replacement upload file", async () => {
		const { parent, root, store } = await testStore();
		const displaced = path.join(parent, "displaced-upload");
		try {
			const input = {
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			const started = await store.begin(input);
			const uploadPath = path.join(root, started.imageId);
			await fs.rename(uploadPath, displaced);
			await fs.writeFile(uploadPath, "foreign data", { mode: 0o600 });
			await expect(store.discard(input.connectionId, input.sessionId, started.imageId)).rejects.toThrow(
				"identity changed",
			);
			expect(await fs.readFile(uploadPath, "utf8")).toBe("foreign data");
			await expect(store.stop()).rejects.toThrow("identity changed");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("does not report deletion after the quarantined file moves", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-store-moved-"));
		const root = path.join(parent, "images");
		const displaced = path.join(parent, "displaced-upload");
		const store = new ImageUploadStore({
			root,
			sweepIntervalMs: 60_000,
			unlink: async filePath => {
				await fs.rename(filePath, displaced);
				await fs.unlink(filePath);
			},
		});
		try {
			await store.start();
			const input = {
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			const started = await store.begin(input);
			await store.chunk({ ...input, imageId: started.imageId, offset: 0, data: png });
			await expect(
				store.discard(input.connectionId, input.sessionId, started.imageId),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readFile(displaced)).toEqual(Buffer.from(png));
			await expect(store.stop()).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("does not unlink through a replacement root", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-store-replaced-"));
		const root = path.join(parent, "images");
		const displaced = path.join(parent, "displaced");
		const sentinel = path.join(root, "replacement-sentinel");
		let replaceOnUnlink = true;
		const store = new ImageUploadStore({
			root,
			sweepIntervalMs: 60_000,
			unlink: async filePath => {
				if (replaceOnUnlink) {
					replaceOnUnlink = false;
					await fs.rename(root, displaced);
					await fs.mkdir(root, { mode: 0o700 });
					await fs.writeFile(sentinel, "foreign data");
				}
				await fs.unlink(filePath);
			},
		});
		try {
			await store.start();
			const input = {
				connectionId: "connection-a",
				sessionId: sessionId("session-a"),
				mimeType: "image/png" as const,
				size: png.byteLength,
				sha256: digest(png),
			};
			const started = await store.begin(input);
			await expect(
				store.discard(input.connectionId, input.sessionId, started.imageId),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readFile(sentinel, "utf8")).toBe("foreign data");
			expect((await fs.readdir(displaced)).filter(name => name.startsWith(".delete-"))).toHaveLength(1);
			await expect(store.stop()).rejects.toThrow("identity changed");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	test("fails closed when the owned root is replaced during teardown", async () => {
		const { parent, root, store } = await testStore();
		const displaced = path.join(parent, "displaced");
		const sentinel = path.join(root, "replacement-sentinel");
		try {
			await fs.rename(root, displaced);
			await fs.mkdir(root, { mode: 0o700 });
			await fs.writeFile(sentinel, "foreign data");
			await expect(store.stop()).rejects.toThrow("identity changed");
			expect(await fs.readFile(sentinel, "utf8")).toBe("foreign data");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
});
