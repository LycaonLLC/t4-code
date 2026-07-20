import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactDescriptor, artifactId } from "@t4-code/host-wire";
import { ArtifactReadError, ArtifactReader } from "../src/artifact-reader";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(): Promise<{
	root: string;
	content: Buffer;
	descriptor: ArtifactDescriptor;
}> {
	const root = await mkdtemp(join(tmpdir(), "omp-artifact-reader-test-"));
	roots.push(root);
	await chmod(root, 0o700);
	const content = Buffer.from("bounded artifact bytes");
	const name = "2001.tool.log";
	await writeFile(join(root, name), content, { mode: 0o600 });
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
		await rm(join(root, descriptor.name!));
		await symlink("missing", join(root, descriptor.name!));
		await expect(reader.read(root, descriptor, 0)).rejects.toBeInstanceOf(ArtifactReadError);
		const controller = new AbortController();
		controller.abort();
		await expect(reader.read(root, descriptor, 0, controller.signal)).rejects.toMatchObject({
			code: "connection_closed",
		});
	});
});
