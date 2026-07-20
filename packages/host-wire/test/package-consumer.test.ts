import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");

async function run(command: string[], cwd: string): Promise<void> {
	const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0)
		throw new Error(`Command ${JSON.stringify(command)} failed with exit ${exitCode}\n${stdout}${stderr}`);
}

test("packed package typechecks under NodeNext and executes through its public export", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "app-wire-consumer-"));
	try {
		const packDir = path.join(tempDir, "packed");
		const consumerDir = path.join(tempDir, "consumer");
		await fs.mkdir(packDir);
		await fs.mkdir(consumerDir);
		await run([process.execPath, "pm", "pack", "--quiet", "--destination", packDir], packageDir);
		const tarballs = (await fs.readdir(packDir)).filter(name => name.endsWith(".tgz"));
		expect(tarballs).toHaveLength(1);
		const tarball = path.join(packDir, tarballs[0]!);

		await Bun.write(
			path.join(consumerDir, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: { "@t4-code/host-wire": `file:${tarball}` },
			}),
		);
		await Bun.write(
			path.join(consumerDir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2024",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					exactOptionalPropertyTypes: true,
					noUncheckedIndexedAccess: true,
					noEmit: true,
					lib: ["ES2024", "DOM"],
				},
				include: ["index.ts"],
			}),
		);
		await Bun.write(
			path.join(consumerDir, "index.ts"),
			`import { decodeCommandResult } from "@t4-code/host-wire/command.js";
import {
	APP_WIRE_VERSION,
	ARTIFACT_MAX_BYTES,
	MAX_TURN_FILE_CHANGES,
	type AppFrame,
	type ArtifactReadChunk,
	type CommandFrame,
	type TurnReviewSnapshot,
	artifactId,
	commandId,
	decodeClientFrame,
	decodeTurnReviewSnapshot,
	hostId,
	requestId,
	turnId,
} from "@t4-code/host-wire";

const command: CommandFrame = {
	v: "omp-app/1",
	type: "command",
	requestId: requestId("request"),
	commandId: commandId("command"),
	hostId: hostId("host"),
	command: "session.create",
	args: { projectId: "project" },
};
const decoded: AppFrame = decodeClientFrame(command);
if (decoded.type !== "command" || decoded.command !== "session.create" || APP_WIRE_VERSION.length === 0)
	throw new Error("packed app-wire public export did not execute");
if (decodeCommandResult("session.cancel", { cancelled: true }).cancelled !== true)
	throw new Error("packed app-wire .js subpath export did not execute");
const review: TurnReviewSnapshot = decodeTurnReviewSnapshot({
	turnId: turnId("turn"),
	baseTree: "base",
	headTree: "head",
	changes: [{ path: "file.ts", status: "modified", kind: "text", state: "pending", additions: 1, deletions: 0 }],
});
const chunk: ArtifactReadChunk = {
	artifactId: artifactId("1"),
	kind: "text",
	mediaType: "text/plain",
	size: 1,
	offset: 0,
	nextOffset: 1,
	complete: true,
	content: "YQ==",
};
if (review.changes.length !== 1 || chunk.size !== 1 || ARTIFACT_MAX_BYTES < MAX_TURN_FILE_CHANGES)
	throw new Error("packed app-wire artifact and turn exports did not execute");
`,
		);

		await run([process.execPath, "install", "--ignore-scripts"], consumerDir);
		await run([process.execPath, tscPath, "--project", "tsconfig.json"], consumerDir);
		await run([process.execPath, "run", "index.ts"], consumerDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}, 30_000);
