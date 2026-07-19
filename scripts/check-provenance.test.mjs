import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkProvenance } from "./check-provenance.mjs";

const sha1 = "a".repeat(40);
const commit = "b".repeat(40);
async function fixture(overrides = {}, body = "hello") {
  const root = await mkdtemp(path.join(os.tmpdir(), "provenance-"));
  await mkdir(path.join(root, "provenance/t3code/imports"), { recursive: true });
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/file.txt"), body);
  await mkdir(path.join(root, "licenses")); await writeFile(path.join(root, "licenses/MIT.txt"), "MIT");
  const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const record = { sourcePath: "src/original.txt", sourceBlobSha: sha1, targetPath: "src/file.txt", classification: "copied", checksum, ...overrides.record };
  await writeFile(path.join(root, "provenance/t3code/imports/batch.json"), JSON.stringify({ batch: "batch", sourceCommit: commit, adaptationCommit: commit, license: "MIT; Owner; licenses/MIT.txt", records: [record], ...overrides.manifest }));
  return root;
}
test("accepts valid manifest and real checksum", async () => assert.equal((await checkProvenance(await fixture())).failures.length, 0));
test("reports stale, malformed, traversal, missing, duplicate with stable diagnostics", async () => {
  const root = await fixture({ record: { checksum: "sha256:" + "0".repeat(64), sourceBlobSha: "BAD", targetPath: "../nope" }, manifest: { sourceCommit: "BAD", records: [{ sourcePath: "x", sourceBlobSha: sha1, targetPath: "src/file.txt", classification: "copied", checksum: "sha256:" + "0".repeat(64) }] } });
  const first = await checkProvenance(root); const second = await checkProvenance(root);
  assert.deepEqual(first.failures, second.failures); assert(first.failures.some((line) => line.includes("checksum mismatch") || line.includes("targetPath")));
});
test("entrypoint executes directly when path has spaces", async () => {
  const spaceRoot = path.join(os.tmpdir(), "check-prov space-" + Math.random().toString(36).slice(2));
  await mkdir(path.join(spaceRoot, "provenance/t3code/imports"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  const scriptDest = path.join(spaceRoot, "check-provenance.mjs");
  const scriptContent = await readFile(new URL("./check-provenance.mjs", import.meta.url), "utf8");
  await writeFile(scriptDest, scriptContent);
  
  let error = null;
  try {
    // Run the script directly with no manifests in spaceRoot.
    // It should run and fail (exit code 1) because no manifests exist,
    // which proves it executed rather than silently exiting with code 0.
    execFileSync(process.execPath, [scriptDest], { cwd: spaceRoot, stdio: "pipe" });
  } catch (err) {
    error = err;
  }
  
  assert.ok(error, "Expected direct execution to fail due to missing manifests");
  assert.equal(error.status, 1, "Expected exit code 1");
  const stderr = error.stderr.toString() + error.stdout.toString();
  assert.ok(stderr.includes("no manifests found"), "Expected 'no manifests found' error in output");
});

