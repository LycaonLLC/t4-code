import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const PUBLIC_ARTIFACT_UMASK = 0o022;

export function withPublicArtifactUmask(action) {
  const previous = process.umask(PUBLIC_ARTIFACT_UMASK);
  try {
    return action();
  } finally {
    process.umask(previous);
  }
}

export function withPublicReadAccess(paths, action) {
  const originalModes = paths.map((path) => [path, statSync(path).mode & 0o777]);
  try {
    for (const [path, mode] of originalModes) chmodSync(path, mode | 0o044);
    return action();
  } finally {
    for (const [path, mode] of originalModes) chmodSync(path, mode);
  }
}

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

export function buildElectronBuilderArgs(args, repoRoot) {
  return ["--config", join(repoRoot, "electron-builder.config.mjs"), ...args, "--publish", "never"];
}

export function buildElectronBuilderInvocation(args, repoRoot, nodeExecutable = process.execPath) {
  const cli = join(repoRoot, "apps", "desktop", "node_modules", "electron-builder", "cli.js");
  return {
    executable: nodeExecutable,
    args: [cli, ...buildElectronBuilderArgs(args, repoRoot)],
    cli,
  };
}

export function runElectronBuilder(args, repoRoot = resolve(import.meta.dirname, "..")) {
  const invocation = buildElectronBuilderInvocation(args, repoRoot);
  if (!existsSync(invocation.cli)) {
    throw new Error(
      `electron-builder CLI not found at ${invocation.cli}; run pnpm install --frozen-lockfile`,
    );
  }
  const packagingAssets = collectFiles(join(repoRoot, "apps", "desktop", "build"));
  const result = withPublicReadAccess(packagingAssets, () =>
    withPublicArtifactUmask(() =>
      spawnSync(invocation.executable, invocation.args, {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: "inherit",
      }),
    ),
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = runElectronBuilder(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
