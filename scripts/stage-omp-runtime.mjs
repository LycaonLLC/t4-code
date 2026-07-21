#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const repoRoot = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(await readFile(join(repoRoot, "compat", "omp-app-matrix.json"), "utf8"));
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const platform = option("platform") ?? process.platform;
const arch = option("arch") ?? process.arch;
const key = `${platform}-${arch}`;
const runtime = matrix.verifiedRuntime;
const artifact = runtime?.artifacts?.[key];
if (!artifact || !/^[a-z0-9][a-z0-9._-]{1,80}$/u.test(artifact.name) || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
  throw new Error(`compat/omp-app-matrix.json has no valid ${key} runtime artifact`);
}
const outputRoot = join(repoRoot, ".artifacts", "omp-runtime");
const output = join(outputRoot, "omp");
const temporary = `${output}.partial-${process.pid}`;
const url = `${runtime.sourceRepository}/releases/download/${runtime.sourceTag}/${artifact.name}`;

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
let current;
try {
  current = await stat(output);
} catch {}
if (!current || current.size !== artifact.size || (await sha256(output)) !== artifact.sha256) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`runtime download failed with HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
  const downloaded = await stat(temporary);
  if (downloaded.size !== artifact.size || (await sha256(temporary)) !== artifact.sha256) {
    await unlink(temporary).catch(() => {});
    throw new Error("downloaded OMP runtime does not match the pinned size and SHA-256 digest");
  }
  await chmod(temporary, 0o755);
  await rename(temporary, output);
}
await writeFile(
  join(outputRoot, "manifest.json"),
  `${JSON.stringify({ version: 1, tag: runtime.sourceTag, platform, arch, executable: basename(output), size: artifact.size, sha256: artifact.sha256 }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`staged ${runtime.sourceTag} ${key} runtime`);
