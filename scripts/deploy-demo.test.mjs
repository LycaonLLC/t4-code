import assert from "node:assert/strict";
import test from "node:test";

import { deployDemo } from "./deploy-demo.mjs";

test("demo deploy replaces only the demo prefix after immutable assets", () => {
  const calls = [];
  deployDemo(
    { bucket: "t4code-net-site-595529182031", distributionId: "E1ABCDEF234567" },
    "/repo",
    (command, args, cwd) => calls.push({ command, args, cwd }),
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
