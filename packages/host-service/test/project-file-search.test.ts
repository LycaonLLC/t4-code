import { afterEach, describe, expect, test } from "bun:test";
import { hostId, sessionId, type SessionId } from "@t4-code/host-wire";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "../src/operations/dispatcher.ts";
import { ProjectFileSearchAuthority } from "../src/project-file-search.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function git(root: string, ...args: string[]): Promise<void> {
	const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
	if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}

function context(signal = new AbortController().signal): OperationContext {
	return {
		hostId: hostId("host-1"),
		sessionId: sessionId("session-1"),
		deviceId: "device-1",
		connectionId: "connection-1",
		capabilities: new Set(["files.list"]),
		abortSignal: signal,
	};
}

describe("project file search authority", () => {
	test("uses the OMP-resolved root, honors Git ignores, ranks names, and skips symlinks", async () => {
		const root = await temporaryDirectory("t4-file-search-");
		const outside = await temporaryDirectory("t4-file-search-outside-");
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "build"), { recursive: true });
		await writeFile(join(root, ".gitignore"), "build/\n");
		await writeFile(join(root, "src", "app.ts"), "export {}\n");
		await writeFile(join(root, "src", "app-helper.ts"), "export {}\n");
		await writeFile(join(root, "build", "app-generated.ts"), "export {}\n");
		await writeFile(join(root, "app\ninvalid.ts"), "export {}\n");
		await writeFile(join(outside, "app-secret.ts"), "secret\n");
		await symlink(join(outside, "app-secret.ts"), join(root, "app-link.ts"));
		await symlink(outside, join(root, "linked-directory"));
		await git(root, "init", "-q");

		let resolvedSession: SessionId | undefined;
		const authority = new ProjectFileSearchAuthority(async id => {
			resolvedSession = id;
			return root;
		});
		const result = await authority.search({ query: "app", limit: 10 }, context());
		expect(resolvedSession).toBe(sessionId("session-1"));
		expect(result.matches.map(match => match.path)).toEqual(["src/app.ts", "src/app-helper.ts"]);
		expect(result.truncated).toBe(false);
	});

	test("falls back to a bounded no-follow directory walk outside Git repositories", async () => {
		const root = await temporaryDirectory("t4-file-search-folder-");
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "settings-panel.tsx"), "export {}\n");
		const authority = new ProjectFileSearchAuthority(async () => root);
		await expect(authority.search({ query: "settings" }, context())).resolves.toEqual({
			matches: [{ path: "src/settings-panel.tsx" }],
			truncated: false,
		});
	});

	test("marks limited results and stops a superseded search for the same session", async () => {
		const root = await temporaryDirectory("t4-file-search-cancel-");
		await writeFile(join(root, "one.ts"), "one\n");
		await writeFile(join(root, "two.ts"), "two\n");
		let releaseFirst: (() => void) | undefined;
		let calls = 0;
		const firstRoot = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		const authority = new ProjectFileSearchAuthority(async () => {
			calls += 1;
			if (calls === 1) await firstRoot;
			return root;
		});
		const first = authority.search({ query: "one", limit: 1 }, context());
		const second = authority.search({ query: "two", limit: 1 }, context());
		releaseFirst?.();
		await expect(first).rejects.toMatchObject({ code: "ABORTED" });
		await expect(second).resolves.toEqual({ matches: [{ path: "two.ts" }], truncated: false });

		const limited = new ProjectFileSearchAuthority(async () => root, { maxEnumeratedPaths: 1 });
		const limitedResult = await limited.search({ query: "t", limit: 1 }, context());
		expect(limitedResult.truncated).toBe(true);
	});
});
