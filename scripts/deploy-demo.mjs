import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const DOCUMENT_URL_PATTERN = /\b(?:href|src)="([^"]+)"/gu;
const BASE_HREF_PATTERN = /<base\s+href="([^"]+)"/u;

export function assertDemoDocumentPaths(document) {
  const baseHref = BASE_HREF_PATTERN.exec(document)?.[1];
  if (baseHref !== "/demo/") {
    throw new Error(`demo base href must be /demo/, received ${baseHref ?? "none"}`);
  }
  const urls = [...document.matchAll(DOCUMENT_URL_PATTERN)].map((match) => match[1]);
  const localUrls = urls.filter(
    (url) =>
      url !== undefined &&
      !url.startsWith("data:") &&
      !url.startsWith("http:") &&
      !url.startsWith("https:") &&
      !url.startsWith("#"),
  );
  if (!localUrls.includes("flutter_bootstrap.js")) {
    throw new Error("demo index is not a Flutter web build");
  }
  const escaped = localUrls.find((url) => {
    const resolved = new URL(url, "https://t4code.net/demo/");
    return resolved.origin !== "https://t4code.net" || !resolved.pathname.startsWith("/demo/");
  });
  if (escaped !== undefined) throw new Error(`demo asset escapes /demo/: ${escaped}`);
}

export function validateDemoBuild(repoRoot) {
  const document = readFileSync(resolve(repoRoot, "apps/site/dist/demo/index.html"), "utf8");
  assertDemoDocumentPaths(document);
  const bootstrap = readFileSync(
    resolve(repoRoot, "apps/site/dist/demo/flutter_bootstrap.js"),
    "utf8",
  );
  if (!bootstrap.includes("registration.unregister()")) {
    throw new Error("demo bootstrap must retire stale service workers");
  }
  if (!bootstrap.includes('"useLocalCanvasKit":true')) {
    throw new Error("demo bootstrap must use local Flutter renderer assets");
  }
  if (existsSync(resolve(repoRoot, "apps/site/dist/demo/flutter_service_worker.js"))) {
    throw new Error("demo build must not publish a Flutter service worker");
  }
}

export function deployDemo(
  config,
  repoRoot = resolve(import.meta.dirname, ".."),
  runCommand = run,
  validateBuild = validateDemoBuild,
) {
  const destination = `s3://${config.bucket}/demo`;
  runCommand("pnpm", ["build:demo"], repoRoot);
  validateBuild(repoRoot);
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
