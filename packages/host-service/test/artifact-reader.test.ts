import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_CHUNK_BYTES, type ArtifactDescriptor, artifactId } from "@t4-code/host-wire";
import { ArtifactReadError, ArtifactReader } from "../src/artifact-reader";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(bytes = Buffer.from("bounded artifact bytes")): Promise<{
	root: string;
	content: Buffer;
	descriptor: ArtifactDescriptor;
}> {
	const root = await fs.mkdtemp(join(tmpdir(), "omp-artifact-reader-test-"));
	roots.push(root);
	await fs.chmod(root, 0o700);
	const content = Buffer.from(bytes);
	const name = "2001.tool.log";
	await fs.writeFile(join(root, name), content, { mode: 0o600 });
	return {
		root,
		content,
		descriptor: {
			artifactId: artifactId("2001"),
			kind: "text",
			mediaType: "text/plain",
			size: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
			name,
			disposition: "attachment",
			retention: "session",
		},
	};
}

describe("ArtifactReader", () => {
	test("returns bounded base64 chunks without exposing host paths", async () => {
		const { root, content, descriptor } = await fixture();
		const result = await new ArtifactReader().read(root, descriptor, 0);
		expect(result).toEqual({
			artifactId: descriptor.artifactId,
			kind: "text",
			mediaType: "text/plain",
			size: content.byteLength,
			offset: 0,
			nextOffset: content.byteLength,
			complete: true,
			content: content.toString("base64"),
		});
		expect(JSON.stringify(result)).not.toContain(root);
	});

	test("fails closed for identity mismatches, symlinks, and cancellation", async () => {
		const { root, descriptor } = await fixture();
		const reader = new ArtifactReader();
		await expect(reader.read(root, { ...descriptor, name: "2001.other.log" }, 0)).rejects.toMatchObject({
			code: "artifact_invalid",
		});
		await fs.rm(join(root, descriptor.name!));
		await fs.symlink("missing", join(root, descriptor.name!));
		await expect(reader.read(root, descriptor, 0)).rejects.toBeInstanceOf(ArtifactReadError);
		const controller = new AbortController();
		controller.abort();
		await expect(reader.read(root, descriptor, 0, controller.signal)).rejects.toMatchObject({
			code: "connection_closed",
		});
	});

	test("hashes a stable descriptor through its opened handle and reuses that verification across chunks", async () => {
		const content = Buffer.alloc(ARTIFACT_CHUNK_BYTES * 2 + 37, 0x61);
		const { root, descriptor } = await fixture(content);
		const readFile = spyOn(fs, "readFile");
		try {
			const reader = new ArtifactReader();
			await expect(reader.read(root, { ...descriptor, sha256: "0".repeat(64) }, 0)).rejects.toMatchObject({
				code: "artifact_invalid",
			});
			expect((await reader.read(root, descriptor, 0)).content).toBe(
				content.subarray(0, ARTIFACT_CHUNK_BYTES).toString("base64"),
			);
			expect((await reader.read(root, descriptor, ARTIFACT_CHUNK_BYTES)).content).toBe(
				content.subarray(ARTIFACT_CHUNK_BYTES, ARTIFACT_CHUNK_BYTES * 2).toString("base64"),
			);
			expect(readFile).not.toHaveBeenCalled();
		} finally {
			readFile.mockRestore();
		}
	});

	test("invalidates verified digests when an artifact mutates or is replaced", async () => {
		const content = Buffer.alloc(ARTIFACT_CHUNK_BYTES + 37, 0x61);
		const { root, descriptor } = await fixture(content);
		const reader = new ArtifactReader();
		const artifactPath = join(root, descriptor.name!);
		await reader.read(root, descriptor, 0);
		await fs.writeFile(artifactPath, Buffer.alloc(content.byteLength, 0x62), { mode: 0o600 });
		await expect(reader.read(root, descriptor, 0)).rejects.toMatchObject({ code: "artifact_invalid" });
		await fs.writeFile(join(root, "replacement"), Buffer.alloc(content.byteLength, 0x63), { mode: 0o600 });
		await fs.rename(join(root, "replacement"), artifactPath);
		await expect(reader.read(root, descriptor, 0)).rejects.toMatchObject({ code: "artifact_invalid" });
	});
});
