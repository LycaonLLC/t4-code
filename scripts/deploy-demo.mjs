import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDeployConfig } from "./deploy-site.mjs";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export function deployDemo(
  config,
  repoRoot = resolve(import.meta.dirname, ".."),
  runCommand = run,
) {
  const destination = `s3://${config.bucket}/demo`;
  runCommand("pnpm", ["build:demo"], repoRoot);
  runCommand(
    "aws",
    [
      "s3",
      "sync",
      "apps/site/dist/demo/assets",
      `${destination}/assets`,
      "--cache-control",
      "public,max-age=31536000,immutable",
      "--only-show-errors",
    ],
    repoRoot,
  );
  runCommand(
    "aws",
    [
      "s3",
      "sync",
      "apps/site/dist/demo",
      destination,
      "--delete",
      "--exclude",
      "assets/*",
      "--cache-control",
      "public,max-age=0,must-revalidate",
      "--only-show-errors",
    ],
    repoRoot,
  );
  runCommand(
    "aws",
    [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      config.distributionId,
      "--paths",
      "/demo",
      "/demo/*",
    ],
    repoRoot,
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    deployDemo(resolveDeployConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
