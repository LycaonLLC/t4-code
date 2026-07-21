import assert from "node:assert/strict";
import test from "node:test";

import { buildDemo } from "./build-demo.mjs";
import { assertDemoDocumentPaths, deployDemo } from "./deploy-demo.mjs";

test("demo build compiles the Flutter client for the /demo/ path", () => {
  const calls = [];
  buildDemo("/repo", (command, args, cwd) => calls.push({ command, args, cwd }));

  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: [
        "--filter",
        "@t4-code/flutter",
        "exec",
        "flutter",
        "build",
        "web",
        "--base-href",
        "/demo/",
        "--csp",
        "--no-web-resources-cdn",
        "--dart-define",
        "T4_DEMO_MODE=true",
        "--output",
        "/repo/apps/site/dist/demo",
      ],
      cwd: "/repo",
    },
  ]);
});

test("site workflow deploys the Flutter demo independently from release publication", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(".github/workflows/deploy-site.yml", "utf8");
  const infrastructure = await readFile("infra/site/cloudformation.yml", "utf8");

  assert.match(workflow, /- "apps\/flutter\/\*\*"/u);
  assert.doesNotMatch(workflow, /- "apps\/web\/\*\*"/u);
  assert.match(workflow, /demo:\n    if: \$\{\{ github\.event_name == 'push' \}\}/u);
  assert.match(workflow, /id: demo_csp/u);
  assert.match(workflow, /grep -Fq "'wasm-unsafe-eval'"/u);
  assert.match(workflow, /if: \$\{\{ steps\.demo_csp\.outputs\.ready == 'true' \}\}/u);
  assert.match(workflow, /Defer Flutter demo until its response policy is active/u);
  assert.match(workflow, /run: pnpm deploy:demo/u);
  assert.match(workflow, /run: pnpm deploy:site/u);
  assert.doesNotMatch(workflow, /deploy:site-bundle/u);
  assert.match(infrastructure, /PathPattern: demo\*/u);
  assert.match(infrastructure, /script-src 'self' 'wasm-unsafe-eval'/u);
  assert.match(infrastructure, /connect-src 'self' https:\/\/fonts\.gstatic\.com/u);
});

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
      '<base href="/demo/"><link href="icons/app.png"><script src="flutter_bootstrap.js"></script>',
    ),
  );
  assert.throws(
    () =>
      assertDemoDocumentPaths(
        '<base href="/demo/"><script src="flutter_bootstrap.js"></script><script src="/assets/app.js"></script>',
      ),
    /demo asset escapes/u,
  );
  assert.throws(
    () =>
      assertDemoDocumentPaths(
        '<base href="/demo/"><script src="flutter_bootstrap.js"></script><script src="//other.example/app.js"></script>',
      ),
    /demo asset escapes/u,
  );
  assert.throws(
    () => assertDemoDocumentPaths('<base href="/"><script src="flutter_bootstrap.js"></script>'),
    /base href/u,
  );
  assert.throws(
    () => assertDemoDocumentPaths('<base href="/demo/"><script src="app.js"></script>'),
    /not a Flutter web build/u,
  );
});
