import assert from "node:assert/strict";
import test from "node:test";

import { assertDemoDocumentPaths, deployDemo } from "./deploy-demo.mjs";
import { deploySiteBundle } from "./deploy-site-bundle.mjs";

test("demo deploy replaces only the demo prefix after immutable assets", () => {
  const calls = [];
  deployDemo(
    { bucket: "t4code-net-site-595529182031", distributionId: "E1ABCDEF234567" },
    "/repo",
    (command, args, cwd) => calls.push({ command, args, cwd }),
    () => undefined,
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], { command: "pnpm", args: ["build:demo"], cwd: "/repo" });
  assert.equal(calls[1].args[2], "apps/site/dist/demo/assets");
  assert.equal(calls[1].args[3], "s3://t4code-net-site-595529182031/demo/assets");
  assert.equal(calls[1].args.includes("--delete"), false);
  assert.equal(calls[2].args[2], "apps/site/dist/demo");
  assert.equal(calls[2].args[3], "s3://t4code-net-site-595529182031/demo");
  assert.equal(calls[2].args.includes("--delete"), true);
  assert.deepEqual(calls[3].args.slice(-3), ["--paths", "/demo", "/demo/*"]);
  assert.deepEqual(
    calls.map(({ cwd }) => cwd),
    ["/repo", "/repo", "/repo", "/repo"],
  );
});

test("demo build keeps every local document URL under /demo", () => {
  assert.doesNotThrow(() =>
    assertDemoDocumentPaths(
      '<link href="/demo/icons/app.png"><script src="/demo/assets/app.js"></script>',
    ),
  );
  assert.throws(
    () => assertDemoDocumentPaths('<script src="/assets/app.js"></script>'),
    /demo asset escapes/u,
  );
  assert.throws(() => assertDemoDocumentPaths("<main>No assets</main>"), /does not reference/u);
});

test("site bundle preserves the demo while deploying immutable release content", () => {
  const calls = [];
  const config = { bucket: "t4code-net-site-595529182031", distributionId: "E1ABCDEF234567" };
  deploySiteBundle(
    config,
    "/release-source",
    "/trusted-demo-source",
    (receivedConfig, root) => calls.push({ kind: "site", config: receivedConfig, root }),
    (receivedConfig, root) => calls.push({ kind: "demo", config: receivedConfig, root }),
  );

  assert.deepEqual(calls, [
    { kind: "site", config, root: "/release-source" },
    { kind: "demo", config, root: "/trusted-demo-source" },
  ]);
  assert.throws(
    () => deploySiteBundle(config, "relative-release-source"),
    /T4_IMMUTABLE_SITE_SOURCE must be an absolute path/u,
  );
});
