import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET_PATTERN = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const DISTRIBUTION_PATTERN = /^E[A-Z0-9]{8,20}$/;

export function resolveDeployConfig(environment = process.env) {
  const bucket = environment.T4_SITE_BUCKET?.trim() ?? "";
  const distributionId = environment.T4_CLOUDFRONT_DISTRIBUTION_ID?.trim() ?? "";
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new Error("T4_SITE_BUCKET must be a valid S3 bucket name");
  }
  if (!DISTRIBUTION_PATTERN.test(distributionId)) {
    throw new Error("T4_CLOUDFRONT_DISTRIBUTION_ID must be a CloudFront distribution ID");
  }
  return { bucket, distributionId };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export function deploySite(config, repoRoot = resolve(import.meta.dirname, ".."), runCommand = run) {
  const destination = `s3://${config.bucket}`;
  runCommand("pnpm", ["--filter", "@t4-code/site", "build"], repoRoot);
  // Publish new content hashes first and retain old hashes for already-cached entry documents.
  runCommand(
    "aws",
    [
      "s3",
      "sync",
      "apps/site/dist/assets",
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
      "apps/site/dist",
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
      "/*",
    ],
    repoRoot,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    deploySite(resolveDeployConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
