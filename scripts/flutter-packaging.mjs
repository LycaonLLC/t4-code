import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "..");
export const flutterRoot = join(repoRoot, "apps", "flutter");
export const releaseRoot = join(repoRoot, "release");
export const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

export function buildFlutter(target) {
  run("pnpm", ["build:host"]);
  run("flutter", ["build", target, "--release"], { cwd: flutterRoot });
}

export function stageHost(bundleResourceDirectory) {
  const host = join(repoRoot, "packages", "host-daemon", "dist", "t4-host");
  if (!existsSync(host)) throw new Error("compiled t4-host is missing");
  const runtime = join(bundleResourceDirectory, "runtime");
  mkdirSync(runtime, { recursive: true });
  const destination = join(runtime, "t4-host");
  copyFileSync(host, destination);
  chmodSync(destination, 0o755);
  return destination;
}

export function resetReleaseDirectory() {
  mkdirSync(releaseRoot, { recursive: true });
}

export function resetDirectory(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

export function copyTree(source, destination) {
  cpSync(source, destination, { recursive: true, force: true });
}
