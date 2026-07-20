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
			expect(await fs.stat(path.join(root, started.imageId))).toBeDefined();
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
			await expect(fs.stat(path.join(root, started.imageId))).rejects.toMatchObject({ code: "ENOENT" });
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
			expect(await fs.stat(path.join(root, started.imageId))).toBeDefined();

			failUnlink = false;
			await store.sweepExpired();
			await expect(fs.stat(path.join(root, started.imageId))).rejects.toMatchObject({ code: "ENOENT" });
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
});
