import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const lifecycle = resolve(import.meta.dirname, "crd-lifecycle.sh");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "t4-crd-lifecycle-"));
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  await mkdir(bin);
  await writeFile(
    join(bin, "kubectl"),
    `#!/bin/sh
set -eu
printf 'kubectl' >>"$COMMAND_LOG"
for argument in "$@"; do printf '\\t%s' "$argument" >>"$COMMAND_LOG"; done
printf '\\n' >>"$COMMAND_LOG"
for argument in "$@"; do
  if [ "$argument" = "--dry-run=server" ] && [ "\${FAIL_DRY_RUN:-0}" = 1 ]; then
    exit 42
  fi
done
if [ "\${1:-}" = get ]; then
  printf '%s' "\${STORED_VERSIONS:-v1alpha1}"
fi
`,
  );
  await writeFile(
    join(bin, "crd-preflight"),
    `#!/bin/sh
set -eu
printf 'validator' >>"$COMMAND_LOG"
for argument in "$@"; do printf '\\t%s' "$argument" >>"$COMMAND_LOG"; done
printf '\\n' >>"$COMMAND_LOG"
case "\${1:-}:\${FAIL_PROPOSED_VALIDATION:-}" in
  fixtures:spec|fixtures:status|served:stale) exit 43 ;;
esac
cat >/dev/null
`,
  );
  await writeFile(
    join(bin, "helm"),
    `#!/bin/sh
set -eu
printf 'helm' >>"$COMMAND_LOG"
for argument in "$@"; do printf '\\t%s' "$argument" >>"$COMMAND_LOG"; done
printf '\\n' >>"$COMMAND_LOG"
`,
  );
  await chmod(join(bin, "kubectl"), 0o755);
  await chmod(join(bin, "helm"), 0o755);
  await chmod(join(bin, "crd-preflight"), 0o755);
  return {
    root,
    log,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, T4_CRD_VALIDATOR: join(bin, "crd-preflight") },
  };
}

async function runLifecycle(args, env = {}) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(lifecycle, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return result;
}

async function commands(log) {
  return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
}

function findCommand(log, predicate, description) {
  const index = log.findIndex(predicate);
  assert.notEqual(index, -1, `missing ${description}:\n${log.join("\n")}`);
  return index;
}

test("upgrade preflights old objects, establishes CRDs, verifies storage, then upgrades workloads", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    value.env,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const log = await commands(value.log);
  const crdPreflight = findCommand(log, (line) => line.includes("apply") && line.includes("--server-side") && line.includes("--dry-run=server") && line.includes("deploy/charts/t4-cluster/crds"), "server-side CRD preflight");
  const oldObjectPreflight = findCommand(log, (line) => line.includes("apply") && line.includes("--dry-run=server") && line.includes("testdata/compat"), "old-object compatibility preflight");
  const crdApply = findCommand(log, (line) => line.includes("apply") && line.includes("--server-side") && !line.includes("--dry-run=server"), "CRD apply");
  const established = findCommand(log, (line) => line.includes("wait") && line.includes("condition=Established") && line.includes("t4clusterhosts.cluster.t4.dev") && line.includes("t4workspaces.cluster.t4.dev") && line.includes("t4sessions.cluster.t4.dev"), "Established wait");
  const storageChecks = log.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("kubectl\tget\tcrd/") && line.includes("status.storedVersions"));
  assert.deepEqual(storageChecks.length, 3);
  const workload = findCommand(log, (line) => line.startsWith("helm\tupgrade\t"), "Helm workload upgrade");
  assert.ok(crdPreflight < oldObjectPreflight);
  assert.ok(oldObjectPreflight < crdApply);
  assert.ok(crdApply < established);
  assert.ok(established < storageChecks[0].index);
  assert.ok(storageChecks.every(({ index }) => index < workload));
  assert.ok(log.every((line) => !line.includes("--force") && !line.includes("replace") && !line.includes("delete\tcrd")), log.join("\n"));
});

test("fresh install establishes and validates CRDs before Helm installs with CRD handling disabled", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["install", "--", "helm", "install", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    value.env,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const log = await commands(value.log);
  const established = findCommand(log, (line) => line.includes("wait") && line.includes("condition=Established"), "Established wait");
  const fixtureValidation = findCommand(log, (line) => line.includes("--dry-run=server") && line.includes("testdata/compat"), "fixture validation");
  const storage = findCommand(log, (line) => line.includes("status.storedVersions"), "stored-version check");
  const workload = findCommand(log, (line) => line.startsWith("helm\tinstall\t"), "Helm install");
  assert.ok(established < fixtureValidation && fixtureValidation < storage && storage < workload);
});

test("candidate schema tightening fails locally before any cluster or workload mutation", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "spec" },
  );
  assert.notEqual(result.code, 0);
  assert.deepEqual(await commands(value.log), [
    `validator\tfixtures\t${join(repoRoot, "deploy/charts/t4-cluster/crds")}\t${join(repoRoot, "packages/cluster-operator/api/v1alpha1/testdata/compat")}`,
  ]);
});

test("persisted status is validated against the proposed status schema before mutation", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "status" },
  );
  assert.notEqual(result.code, 0);
  assert.deepEqual(await commands(value.log), [
    `validator\tfixtures\t${join(repoRoot, "deploy/charts/t4-cluster/crds")}\t${join(repoRoot, "packages/cluster-operator/api/v1alpha1/testdata/compat")}`,
  ]);
});

test("retained Established cannot pass readiness while served OpenAPI is stale", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds"],
    { ...value.env, FAIL_PROPOSED_VALIDATION: "stale" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  const apply = findCommand(log, (line) => line.includes("kubectl\tapply") && !line.includes("--dry-run=server"), "non-dry-run CRD apply");
  const established = findCommand(log, (line) => line.includes("condition=Established"), "Established wait");
  const served = findCommand(log, (line) => line.startsWith("validator\tserved\t"), "served-schema semantic verification");
  assert.ok(apply < established && established < served, log.join("\n"));
  assert.ok(log.every((line) => !line.startsWith("helm\t")), log.join("\n"));
});

test("failed server preflight leaves CRDs and workloads untouched", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    { ...value.env, FAIL_DRY_RUN: "1" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  assert.equal(log.length, 1, log.join("\n"));
  assert.match(log[0], /apply.*--server-side.*--dry-run=server/u);
});

test("an unexpected stored version stops workload rollout", async () => {
  const value = await fixture();
  const result = await runLifecycle(
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "deploy/charts/t4-cluster", "--namespace", "t4-system", "--skip-crds"],
    { ...value.env, STORED_VERSIONS: "v1alpha1,v1beta1" },
  );
  assert.notEqual(result.code, 0);
  const log = await commands(value.log);
  assert.ok(log.some((line) => line.includes("status.storedVersions")));
  assert.ok(log.every((line) => !line.startsWith("helm\t")), log.join("\n"));
});

test("force replacement and implicit Helm CRD handling are rejected before cluster access", async () => {
  const value = await fixture();
  for (const args of [
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart", "--skip-crds", "--force"],
    ["upgrade", "--", "helm", "upgrade", "t4-cluster", "chart"],
  ]) {
    const result = await runLifecycle(args, value.env);
    assert.equal(result.code, 64, `${result.stdout}\n${result.stderr}`);
  }
});

test("future storage migration explicitly retires the old stored version only after rewrite and dual-version reads", async () => {
  const docs = await readFile(join(repoRoot, "docs/CLUSTER_OPERATOR.md"), "utf8");
  const migration = docs.slice(docs.indexOf("### Future `v1beta1`"), docs.indexOf("### Workload rollback"));
  const storageFlip = migration.indexOf("`v1beta1` storage to true");
  const rewrite = migration.indexOf("rewrite every object");
  const verifyReads = migration.indexOf("read every rewritten object through both served versions");
  const statusUpdate = migration.indexOf("/status");
  const exactAssertion = migration.indexOf("exactly `[v1beta1]`");
  const oldStillServed = migration.indexOf("Keep `v1alpha1` served");
  assert.ok(storageFlip >= 0 && storageFlip < rewrite, migration);
  assert.ok(rewrite < verifyReads && verifyReads < statusUpdate, migration);
  assert.ok(statusUpdate < exactAssertion && exactAssertion < oldStillServed, migration);
  assert.match(migration, /patch customresourcedefinition[^\n]*--subresource=status/u);
});
