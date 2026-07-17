import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const helper = resolve(import.meta.dirname, "..", "ops", "t4-maintainer", "publish-omp-atomic.sh");
const baseTag = "v1.2.3";
const integrationTag = "t4code-1.2.3-appserver-1";
const secondIntegrationTag = "t4code-1.2.3-appserver-2";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function ref(repository, name) {
  const output = run("git", ["ls-remote", repository, name]);
  return output === "" ? "" : output.split(/\s/u)[0];
}

async function fixture({ reject = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "t4-atomic-publish-"));
  const official = join(root, "official.git");
  const fork = join(root, "fork.git");
  const source = join(root, "source");
  const state = join(root, "state");
  const hookLog = join(root, "pre-receive.log");
  run("git", ["init", "--bare", official]);
  run("git", ["init", "--bare", fork]);
  run("git", ["init", source]);
  run("git", ["-C", source, "config", "user.name", "T4 Maintainer Test"]);
  run("git", ["-C", source, "config", "user.email", "maintainer@example.invalid"]);
  await writeFile(join(source, "base.txt"), "official base\n");
  run("git", ["-C", source, "add", "base.txt"]);
  run("git", ["-C", source, "commit", "-m", "official base"]);
  run("git", ["-C", source, "branch", "-M", "main"]);
  run("git", ["-C", source, "tag", "-a", baseTag, "-m", baseTag]);
  const upstreamCommit = run("git", ["-C", source, "rev-parse", "HEAD"]);
  const baseTagObject = run("git", ["-C", source, "rev-parse", `refs/tags/${baseTag}`]);
  run("git", ["-C", source, "remote", "add", "official", official]);
  run("git", ["-C", source, "remote", "add", "origin", fork]);
  run("git", ["-C", source, "push", official, "main", `refs/tags/${baseTag}`]);
  run("git", ["-C", source, "push", fork, "main"]);

  run("git", ["-C", source, "switch", "-c", "t4code/main"]);
  await writeFile(join(source, "integration.txt"), "t4 integration\n");
  run("git", ["-C", source, "add", "integration.txt"]);
  run("git", ["-C", source, "commit", "-m", "T4 integration"]);
  run("git", ["-C", source, "tag", "-a", integrationTag, "-m", integrationTag]);
  const integrationCommit = run("git", ["-C", source, "rev-parse", "HEAD"]);
  const integrationTagObject = run("git", [
    "-C",
    source,
    "rev-parse",
    `refs/tags/${integrationTag}`,
  ]);

  await mkdir(join(fork, "hooks"), { recursive: true });
  run("git", ["--git-dir", fork, "config", "core.hooksPath", join(fork, "hooks")]);
  const hook = `#!/usr/bin/env bash
set -euo pipefail
payload=$(cat)
printf '%s\n' "$payload" >>${JSON.stringify(hookLog)}
${reject ? `grep -q 'refs/tags/${integrationTag}' <<<"$payload" && exit 1` : "exit 0"}
`;
  await writeFile(join(fork, "hooks", "pre-receive"), hook);
  await chmod(join(fork, "hooks", "pre-receive"), 0o755);

  const env = {
    ...process.env,
    T4_ATOMIC_TEST_MODE: "1",
    T4_ATOMIC_STATE_DIR: state,
    T4_ATOMIC_EXPECTED_UPSTREAM_TAG: baseTag,
    T4_ATOMIC_EXPECTED_UPSTREAM_COMMIT: upstreamCommit,
    T4_ATOMIC_OFFICIAL_URL: official,
    T4_ATOMIC_FORK_URL: fork,
    T4_MAINTAINER_GIT: "git",
    T4_MAINTAINER_JQ: "jq",
    T4_MAINTAINER_SYNC: "sync",
  };
  return {
    root,
    official,
    fork,
    source,
    state,
    hookLog,
    env,
    upstreamCommit,
    baseTagObject,
    integrationCommit,
    integrationTagObject,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("atomic publisher rejects relative option-like state roots before creating state", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const result = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    {
      encoding: "utf8",
      env: { ...value.env, T4_ATOMIC_STATE_DIR: "-unsafe-state" },
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /T4_ATOMIC_STATE_DIR must be an absolute path/u);
});

test("atomic publisher preflights its configured date before creating state", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const missingDate = join(value.root, "missing-date");
  const result = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    {
      encoding: "utf8",
      env: { ...value.env, T4_MAINTAINER_DATE: missingDate },
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /required command is unavailable:/u);
  await assert.rejects(lstat(value.state), { code: "ENOENT" });
});

test("atomic OMP publisher updates exactly the three fixed refs in one receive", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const result = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receiptPath = result.stdout.trim();
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.atomicPush, true);
  assert.equal(receipt.pushedRefCount, 3);
  assert.equal((await lstat(value.state)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(value.state, integrationTag))).mode & 0o777, 0o700);
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(value.state, integrationTag, "push.log"))).mode & 0o777, 0o600);
  assert.equal(ref(value.fork, `refs/tags/${baseTag}`), value.baseTagObject);
  assert.equal(ref(value.fork, "refs/heads/t4code/main"), value.integrationCommit);
  assert.equal(ref(value.fork, `refs/tags/${integrationTag}`), value.integrationTagObject);
  assert.equal(
    ref(value.fork, `refs/tags/${integrationTag}^{}`),
    value.integrationCommit,
  );
  const updates = (await readFile(value.hookLog, "utf8")).trim().split("\n");
  assert.equal(updates.length, 3, updates.join("\n"));
  assert.deepEqual(
    updates.map((line) => line.split(" ")[2]).sort(),
    [`refs/heads/t4code/main`, `refs/tags/${baseTag}`, `refs/tags/${integrationTag}`].sort(),
  );

  await rm(receiptPath);
  const recovered = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.equal(recovered.stdout.trim(), receiptPath);
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).atomicPush, true);
  assert.equal(
    (await readFile(value.hookLog, "utf8")).trim().split("\n").length,
    3,
    "receipt recovery must not push a second transaction",
  );
});

test("a rejected ref rolls back the entire advertised atomic transaction", async (t) => {
  const value = await fixture({ reject: true });
  t.after(() => value.cleanup());
  const result = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /single atomic three-ref publication push was rejected/u);
  assert.equal(ref(value.fork, `refs/tags/${baseTag}`), "");
  assert.equal(ref(value.fork, "refs/heads/t4code/main"), "");
  assert.equal(ref(value.fork, `refs/tags/${integrationTag}`), "");
  assert.equal(
    await readFile(join(value.state, integrationTag, "intent.json"), "utf8").then(Boolean),
    true,
  );
  await assert.rejects(readFile(join(value.state, integrationTag, "receipt.json")));
  const updates = (await readFile(value.hookLog, "utf8")).trim().split("\n");
  assert.equal(updates.length, 3, updates.join("\n"));
});

test("a later integration revision reuses the exact base tag and advances atomically", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const first = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

  await writeFile(join(value.source, "second-integration.txt"), "second integration\n");
  run("git", ["-C", value.source, "add", "second-integration.txt"]);
  run("git", ["-C", value.source, "commit", "-m", "Second T4 integration"]);
  run("git", ["-C", value.source, "tag", "-a", secondIntegrationTag, "-m", secondIntegrationTag]);
  const secondCommit = run("git", ["-C", value.source, "rev-parse", "HEAD"]);
  const secondTagObject = run("git", [
    "-C",
    value.source,
    "rev-parse",
    `refs/tags/${secondIntegrationTag}`,
  ]);

  const second = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", secondIntegrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(ref(value.fork, `refs/tags/${baseTag}`), value.baseTagObject);
  assert.equal(ref(value.fork, "refs/heads/t4code/main"), secondCommit);
  assert.equal(ref(value.fork, `refs/tags/${secondIntegrationTag}`), secondTagObject);
  assert.match(
    await readFile(join(value.state, secondIntegrationTag, "push.log"), "utf8"),
    new RegExp(`refs/tags/${baseTag.replaceAll(".", "\\.")}`, "u"),
  );
  assert.equal(
    (await readFile(value.hookLog, "utf8")).trim().split("\n").length,
    5,
    "the second receive changes only product and its new integration tag",
  );
});

test("a crash after staging is reconstructed safely before any push", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const interrupted = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    {
      encoding: "utf8",
      env: { ...value.env, T4_ATOMIC_TEST_CRASH_AFTER_STAGING: "1" },
    },
  );
  assert.equal(interrupted.status, 86, `${interrupted.stdout}\n${interrupted.stderr}`);
  assert.equal(ref(value.fork, `refs/tags/${baseTag}`), "");
  assert.equal(ref(value.fork, "refs/heads/t4code/main"), "");
  assert.equal(ref(value.fork, `refs/tags/${integrationTag}`), "");
  await assert.rejects(readFile(value.hookLog));

  const resumed = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(ref(value.fork, `refs/tags/${baseTag}`), value.baseTagObject);
  assert.equal(ref(value.fork, "refs/heads/t4code/main"), value.integrationCommit);
  assert.equal(ref(value.fork, `refs/tags/${integrationTag}`), value.integrationTagObject);
  assert.equal(
    (await readFile(value.hookLog, "utf8")).trim().split("\n").length,
    3,
  );
});

test("recovery rejects mutated durable staging before a second push", async (t) => {
  const value = await fixture({ reject: true });
  t.after(() => value.cleanup());
  const rejected = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
  const staging = join(value.state, integrationTag, "repository.git");
  run("git", [
    "--git-dir",
    staging,
    "update-ref",
    `refs/tags/${integrationTag}`,
    `refs/tags/${baseTag}`,
  ]);

  const resumed = spawnSync(
    helper,
    ["--repo", value.source, "--integration-tag", integrationTag],
    { encoding: "utf8", env: value.env },
  );
  assert.notEqual(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.match(resumed.stderr, /staging refs do not match/u);
  assert.equal(
    (await readFile(value.hookLog, "utf8")).trim().split("\n").length,
    3,
    "corrupt staging must be rejected before a second receive",
  );
  assert.equal(ref(value.fork, `refs/tags/${baseTag}`), "");
  assert.equal(ref(value.fork, "refs/heads/t4code/main"), "");
  assert.equal(ref(value.fork, `refs/tags/${integrationTag}`), "");
});
