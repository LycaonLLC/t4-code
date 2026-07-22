import assert from "node:assert/strict";
import test from "node:test";

import { deploySite, resolveDeployConfig } from "./deploy-site.mjs";

const commit = "a".repeat(40);
const expectedConfig = {
  namespace: "t4-site",
  release: "t4-site",
  chart: "deploy/charts/t4-site",
  imageRepository: "harbor.tailb18de3.ts.net/linkedin-bot/t4-site",
  revisionTarget: "origin",
  imageTag: commit,
};

test("site deploy config binds production to the exact commit image", () => {
  assert.deepEqual(resolveDeployConfig({ CI_COMMIT_SHA: commit }), expectedConfig);
  assert.deepEqual(resolveDeployConfig({ T4_SITE_IMAGE_TAG: commit }), expectedConfig);
});

test("site deploy config rejects mutable image tags and production target overrides", () => {
  assert.throws(() => resolveDeployConfig({}), /40-character commit SHA/u);
  assert.throws(() => resolveDeployConfig({ T4_SITE_IMAGE_TAG: "latest" }), /40-character commit SHA/u);
  assert.throws(
    () => resolveDeployConfig({ T4_SITE_IMAGE_TAG: commit.toUpperCase() }),
    /40-character commit SHA/u,
  );
  assert.throws(
    () => resolveDeployConfig({ T4_SITE_IMAGE_TAG: commit, CI_COMMIT_SHA: "b".repeat(40) }),
    /must match CI_COMMIT_SHA/u,
  );
  assert.throws(
    () => resolveDeployConfig({ T4_SITE_IMAGE_TAG: commit, T4_SITE_NAMESPACE: "default" }),
    /T4_SITE_NAMESPACE must be t4-site/u,
  );
  assert.throws(
    () => resolveDeployConfig({ T4_SITE_IMAGE_TAG: commit, T4_SITE_REVISION_TARGET: "public" }),
    /T4_SITE_REVISION_TARGET must be origin/u,
  );
});

test("site deploy atomically applies Helm, confirms rollout, and verifies the exact origin revision", async () => {
  const calls = [];
  const revisions = [];
  await deploySite(
    expectedConfig,
    "/repo",
    (command, args, cwd) => calls.push({ command, args, cwd }),
    async (options) => revisions.push(options),
  );

  assert.deepEqual(
    calls.map(({ command }) => command),
    ["helm", "kubectl"],
  );
  assert.deepEqual(calls[0].args, [
    "upgrade",
    "--install",
    "t4-site",
    "deploy/charts/t4-site",
    "--namespace",
    "t4-site",
    "--create-namespace",
    "--atomic",
    "--wait",
    "--timeout",
    "10m",
    "--set-string",
    "image.repository=harbor.tailb18de3.ts.net/linkedin-bot/t4-site",
    "--set-string",
    `image.tag=${commit}`,
  ]);
  assert.deepEqual(calls[1].args, [
    "--namespace",
    "t4-site",
    "rollout",
    "status",
    "deployment/t4-site",
    "--timeout",
    "10m",
  ]);
  assert.deepEqual(
    calls.map(({ cwd }) => cwd),
    ["/repo", "/repo"],
  );
  assert.deepEqual(revisions, [{ expectedRevision: commit, target: "origin" }]);
});
