import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TRANSCRIPT_IMAGE_CHUNK_BYTES, TRANSCRIPT_IMAGE_MAX_BYTES } from "@t4-code/host-wire";
import { TranscriptImageError, TranscriptImageReader } from "../src/transcript-image-reader.ts";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function temporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-transcript-images-"));
	await fs.chmod(root, 0o700);
	return root;
}

async function writeBlob(root: string, data: Buffer): Promise<string> {
	const sha256 = createHash("sha256").update(data).digest("hex");
	await fs.writeFile(path.join(root, sha256), data, { mode: 0o600 });
	return sha256;
}

describe("transcript image reader", () => {
	test("returns canonical 256 KiB chunks from a verified immutable cache", async () => {
		const root = await temporaryRoot();
		try {
			const data = Buffer.concat([pngSignature, Buffer.alloc(TRANSCRIPT_IMAGE_CHUNK_BYTES + 17, 0x5a)]);
			const sha256 = await writeBlob(root, data);
			await fs.chmod(root, 0o775);
			await fs.chmod(path.join(root, sha256), 0o664);
			const reader = new TranscriptImageReader({ root });
			const first = await reader.read(sha256, "image/png", 0);
			expect(first).toMatchObject({
				sha256,
				mimeType: "image/png",
				size: data.byteLength,
				offset: 0,
				nextOffset: TRANSCRIPT_IMAGE_CHUNK_BYTES,
				complete: false,
			});
			expect(Buffer.from(first.content, "base64")).toEqual(data.subarray(0, TRANSCRIPT_IMAGE_CHUNK_BYTES));

			await fs.unlink(path.join(root, sha256));
			const second = await reader.read(sha256, "image/png", first.nextOffset);
			expect(second.complete).toBe(true);
			expect(second.nextOffset).toBe(data.byteLength);
			expect(Buffer.from(second.content, "base64")).toEqual(data.subarray(first.nextOffset));
			reader.clear();
			await expect(reader.read(sha256, "image/png", 0)).rejects.toMatchObject({ code: "image_not_found" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects path-shaped digests, symlinks, world-writable files, wrong hashes, MIME mismatches, and oversize blobs", async () => {
		const root = await temporaryRoot();
		try {
			const data = Buffer.concat([pngSignature, Buffer.from("image")]);
			const validHash = await writeBlob(root, data);
			const reader = new TranscriptImageReader({ root, maxCacheBytes: 1, maxCacheEntries: 1 });
			await expect(reader.read(`../${validHash}`, "image/png", 0)).rejects.toBeInstanceOf(TranscriptImageError);
			await expect(reader.read(validHash.toUpperCase(), "image/png", 0)).rejects.toBeInstanceOf(
				TranscriptImageError,
			);
			await expect(reader.read(validHash, "image/jpeg", 0)).rejects.toMatchObject({ code: "image_invalid" });
			await expect(reader.read(validHash, "image/png", data.byteLength)).rejects.toMatchObject({
				code: "image_invalid",
			});

			const writableData = Buffer.concat([pngSignature, Buffer.from("writable")]);
			const writableHash = await writeBlob(root, writableData);
			await fs.chmod(path.join(root, writableHash), 0o602);
			await expect(reader.read(writableHash, "image/png", 0)).rejects.toMatchObject({ code: "image_invalid" });

			const wrongHash = "c".repeat(64);
			await fs.writeFile(path.join(root, wrongHash), data, { mode: 0o600 });
			await expect(reader.read(wrongHash, "image/png", 0)).rejects.toMatchObject({ code: "image_invalid" });

			const symlinkHash = "d".repeat(64);
			await fs.symlink(path.join(root, validHash), path.join(root, symlinkHash));
			await expect(reader.read(symlinkHash, "image/png", 0)).rejects.toMatchObject({ code: "image_not_found" });

			const oversizeHash = "e".repeat(64);
			const oversize = await fs.open(path.join(root, oversizeHash), "w", 0o600);
			try {
				await oversize.truncate(TRANSCRIPT_IMAGE_MAX_BYTES + 1);
			} finally {
				await oversize.close();
			}
			await expect(reader.read(oversizeHash, "image/png", 0)).rejects.toMatchObject({ code: "image_invalid" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a symlinked or world-writable blob root", async () => {
		const root = await temporaryRoot();
		const link = `${root}-link`;
		try {
			const data = Buffer.concat([pngSignature, Buffer.from("root")]);
			const sha256 = await writeBlob(root, data);
			await fs.symlink(root, link);
			await expect(new TranscriptImageReader({ root: link }).read(sha256, "image/png", 0)).rejects.toMatchObject({
				code: "image_invalid",
			});
			await fs.unlink(link);
			await fs.chmod(root, 0o702);
			await expect(new TranscriptImageReader({ root }).read(sha256, "image/png", 0)).rejects.toMatchObject({
				code: "image_invalid",
			});
		} finally {
			await fs.rm(link, { force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
