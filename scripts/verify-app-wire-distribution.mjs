import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Deterministic golden-corpus hash:
 * recursively enumerate fixture files, sort their POSIX relative paths, then
 * hash UTF-8(path) + NUL + raw file bytes + NUL for each file in that order.
 * Paths and bytes are both covered, while filesystem order and mtimes are not.
 */
export function goldenCorpusSha256(root) {
	const fixtureRoot = resolve(root);
	const paths = [];
	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) paths.push(relative(fixtureRoot, absolute).split(sep).join("/"));
		}
	}
	visit(fixtureRoot);
	paths.sort();
	const digest = createHash("sha256");
	for (const path of paths) {
		digest.update(path, "utf8");
		digest.update(Buffer.from([0]));
		digest.update(readFileSync(join(fixtureRoot, ...path.split("/"))));
		digest.update(Buffer.from([0]));
	}
	return digest.digest("hex");
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	const repoRoot = resolve(import.meta.dirname, "..");
	const manifestPath = join(repoRoot, "vendor/app-wire/manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const tarballPath = join(repoRoot, "vendor/app-wire", manifest.tarball);
	const fixtureRoot =
		process.argv[2] ?? resolve(repoRoot, "packages/host-wire/fixtures/v1");
	if (!existsSync(fixtureRoot) || !statSync(fixtureRoot).isDirectory()) {
		console.error(`installed app-wire fixtures not found: ${fixtureRoot}; run pnpm install first`);
		process.exitCode = 1;
	} else {
		const tarballSha256 = sha256(tarballPath);
		const goldenCorpusSha256Value = goldenCorpusSha256(fixtureRoot);
		if (tarballSha256 !== manifest.tarballSha256 || goldenCorpusSha256Value !== manifest.goldenCorpusSha256) {
			console.error(
				`manifest mismatch: tarball=${tarballSha256} golden=${goldenCorpusSha256Value}`,
			);
			process.exitCode = 1;
		} else {
			console.log(`tarballSha256=${tarballSha256}`);
			console.log(`goldenCorpusSha256=${goldenCorpusSha256Value}`);
		}
	}
}
