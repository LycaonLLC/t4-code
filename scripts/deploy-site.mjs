import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const FIXED_CONFIG = Object.freeze({
  namespace: "t4-site",
  release: "t4-site",
  chart: "deploy/charts/t4-site",
  imageRepository: "harbor.tailb18de3.ts.net/linkedin-bot/t4-site",
  hostname: "t4code.com",
});

export function resolveDeployConfig(environment = process.env) {
  const imageTag = (environment.T4_SITE_IMAGE_TAG ?? environment.CI_COMMIT_SHA ?? "").trim();
  if (!COMMIT_PATTERN.test(imageTag)) {
    throw new Error("T4_SITE_IMAGE_TAG or CI_COMMIT_SHA must be an exact lowercase 40-character commit SHA");
  }

  for (const [name, expected] of [
    ["T4_SITE_NAMESPACE", FIXED_CONFIG.namespace],
    ["T4_SITE_RELEASE", FIXED_CONFIG.release],
    ["T4_SITE_CHART", FIXED_CONFIG.chart],
    ["T4_SITE_IMAGE_REPOSITORY", FIXED_CONFIG.imageRepository],
    ["T4_SITE_HOSTNAME", FIXED_CONFIG.hostname],
  ]) {
    const configured = environment[name]?.trim();
    if (configured && configured !== expected) {
      throw new Error(`${name} must be ${expected}`);
    }
  }

  return { ...FIXED_CONFIG, imageTag };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export function deploySite(config, repoRoot = resolve(import.meta.dirname, ".."), runCommand = run) {
  const timeout = "10m";
  runCommand(
    "helm",
    [
      "upgrade",
      "--install",
      config.release,
      config.chart,
      "--namespace",
      config.namespace,
      "--create-namespace",
      "--atomic",
      "--wait",
      "--timeout",
      timeout,
      "--set-string",
      `image.repository=${config.imageRepository}`,
      "--set-string",
      `image.tag=${config.imageTag}`,
    ],
    repoRoot,
  );
  runCommand(
    "kubectl",
    [
      "--namespace",
      config.namespace,
      "rollout",
      "status",
      `deployment/${config.release}`,
      "--timeout",
      timeout,
    ],
    repoRoot,
  );
  runCommand(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "12",
      "--retry-all-errors",
      "--retry-delay",
      "5",
      "--proto",
      "=https",
      "--tlsv1.2",
      `https://${config.hostname}/`,
    ],
    repoRoot,
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    deploySite(resolveDeployConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
