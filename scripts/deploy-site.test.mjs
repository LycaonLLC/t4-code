import assert from "node:assert/strict";
import test from "node:test";

import { deploySite, resolveDeployConfig } from "./deploy-site.mjs";

test("site deploy config accepts exact scoped AWS targets", () => {
  assert.deepEqual(
    resolveDeployConfig({
      T4_SITE_BUCKET: "t4code-net-site-595529182031",
      T4_CLOUDFRONT_DISTRIBUTION_ID: "E1ABCDEF234567",
    }),
    {
      bucket: "t4code-net-site-595529182031",
      distributionId: "E1ABCDEF234567",
    },
  );
});

test("site deploy config rejects missing or malformed targets", () => {
  assert.throws(() => resolveDeployConfig({}), /T4_SITE_BUCKET/);
  assert.throws(
    () =>
      resolveDeployConfig({
        T4_SITE_BUCKET: "https://example.com",
        T4_CLOUDFRONT_DISTRIBUTION_ID: "E1ABCDEF234567",
      }),
    /T4_SITE_BUCKET/,
  );
  assert.throws(
    () =>
      resolveDeployConfig({
        T4_SITE_BUCKET: "t4code-net-site-595529182031",
        T4_CLOUDFRONT_DISTRIBUTION_ID: "not-a-distribution",
      }),
    /T4_CLOUDFRONT_DISTRIBUTION_ID/,
  );
});

test("site deploy uploads immutable assets before switching entry documents", () => {
  const calls = [];
  deploySite(
    { bucket: "t4code-net-site-595529182031", distributionId: "E1ABCDEF234567" },
    "/repo",
    (command, args, cwd) => calls.push({ command, args, cwd }),
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ command }) => command), ["pnpm", "aws", "aws", "aws"]);
  assert.equal(calls[1].args[2], "apps/site/dist/assets");
  assert.equal(calls[2].args[2], "apps/site/dist");
  assert.equal(calls[1].args.includes("--delete"), false);
  assert.equal(calls[2].args.includes("--delete"), true);
  assert.deepEqual(calls.map(({ cwd }) => cwd), ["/repo", "/repo", "/repo", "/repo"]);
});
