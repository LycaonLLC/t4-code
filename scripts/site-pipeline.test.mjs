import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import yaml from "js-yaml";

async function loadYaml(path) {
  return yaml.load(await readFile(path, "utf8"));
}

test("GitHub only builds and verifies the exact public revision", async () => {
  const [source, workflow] = await Promise.all([
    readFile(".github/workflows/deploy-site.yml", "utf8"),
    loadYaml(".github/workflows/deploy-site.yml"),
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push.branches, ["main", "master"]);

  const job = workflow.jobs["verify-production"];
  const commands = job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /pnpm test:deploy:site/u);
  assert.match(commands, /pnpm build:site/u);
  assert.match(commands, /verify-site-revision\.mjs[\s\S]*--target public[\s\S]*--expected "\$SOURCE_SHA"/u);
  assert.match(commands, /wait-for-release-assets\.mjs/u);
  assert.match(commands, /git merge-base --is-ancestor "\$source_sha" "\$TRUSTED_SHA"/u);
  assert.match(source, /steps\.release_state\.outputs\.state == 'not-published'/u);
  assert.doesNotMatch(source, /kubeconfig|kubectl|\bhelm\b|aws-access-key|aws_secret|amazonaws/iu);
});

test("Woodpecker has a complete main-only site chain independent of controller publication", async () => {
  const pipeline = await loadYaml(".woodpecker.yml");
  const siteSteps = {
    "harbor-auth-site": ["dependencies"],
    "build-site": ["harbor-auth-site"],
    "promote-site": ["build-site"],
    "deploy-site": ["promote-site"],
    "cleanup-site-registry-auth": ["deploy-site"],
  };

  for (const [name, dependencies] of Object.entries(siteSteps)) {
    const step = pipeline.steps[name];
    assert.ok(step, `${name} must exist`);
    assert.deepEqual(step.depends_on, dependencies);
    assert.equal(step.when[0].event, "push");
    assert.equal(step.when[0].branch, "main");
    assert.ok(!JSON.stringify(step.depends_on).includes("controller"));
  }
  assert.equal(
    pipeline.steps["deploy-site"].backend_options.kubernetes.serviceAccountName,
    "woodpecker-dev-verifier",
  );
  assert.equal(pipeline.steps["harbor-auth-site"].environment, undefined);
  assert.equal(
    pipeline.steps["build-site"].environment.T4_REGISTRY_AUTH_DIR,
    undefined,
  );
  assert.equal(
    pipeline.steps["promote-site"].environment.T4_REGISTRY_AUTH_DIR,
    undefined,
  );
  assert.deepEqual(pipeline.steps["cleanup-site-registry-auth"].commands, [
    "rm -rf .site-ci",
  ]);
});

test("site image build accepts only an exact 40-character commit SHA", () => {
  const run = (commit) =>
    spawnSync("sh", ["scripts/build-site-image.sh"], {
      encoding: "utf8",
      env: { CI_COMMIT_SHA: commit, PATH: process.env.PATH },
    });

  const valid = run("a".repeat(40));
  assert.notEqual(valid.status, 64);
  assert.match(valid.stderr, /BUILDKIT_ADDR.*required/u);

  const truncated = run("a".repeat(39));
  assert.equal(truncated.status, 64);
  assert.match(truncated.stderr, /exact lowercase 40-character SHA/u);
});

test("site image build and promotion use only the immutable Woodpecker commit SHA", async () => {
  const [build, promote] = await Promise.all([
    readFile("scripts/build-site-image.sh", "utf8"),
    readFile("scripts/promote-site-image.sh", "utf8"),
  ]);
  assert.match(build, /build-arg:SOURCE_COMMIT=\$CI_COMMIT_SHA/u);
  assert.match(build, /repository="\$HARBOR_REGISTRY\/\$HARBOR_PROJECT\/quarantine\/t4-site"/u);
  assert.match(build, /reference="\$repository:\$CI_COMMIT_SHA"/u);
  assert.match(build, /--opt "attest:sbom="/u);
  assert.match(build, /--opt "attest:provenance=mode=max"/u);
  assert.doesNotMatch(build, /--attest/u);
  assert.match(promote, /quarantine\/t4-site:\$CI_COMMIT_SHA/u);
  assert.match(promote, /linkedin-bot\/t4-site:\$CI_COMMIT_SHA|\$HARBOR_PROJECT\/t4-site:\$CI_COMMIT_SHA/u);
  assert.match(promote, /oras resolve --plain-http/u);
  assert.match(promote, /oras copy --plain-http --recursive/u);
  assert.doesNotMatch(`${build}\n${promote}`, /:latest\b/u);
});
