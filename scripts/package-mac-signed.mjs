import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runElectronBuilder } from "./run-electron-builder.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") {
  console.error(`package:mac requires macOS (darwin); current platform is ${process.platform}`);
  process.exit(1);
}
for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
  if (!process.env[name]) {
    console.error(`package:mac requires ${name}`);
    process.exit(1);
  }
}
const stageRuntime = spawnSync("pnpm", ["stage:omp-runtime:mac"], { cwd: repoRoot, stdio: "inherit" });
if (stageRuntime.error) throw stageRuntime.error;
if (stageRuntime.status !== 0) process.exit(stageRuntime.status ?? 1);
const prepackage = spawnSync("pnpm", ["prepackage"], {
  cwd: repoRoot,
  env: { ...process.env, T4_MACOS_SIGNED_BUILD: "1", T4_REQUIRE_BUNDLED_OMP: "1" },
  stdio: "inherit",
});
if (prepackage.error) throw prepackage.error;
if (prepackage.status !== 0) process.exit(prepackage.status ?? 1);
process.env.T4_MACOS_SIGNED_BUILD = "1";
process.exitCode = runElectronBuilder(["--mac", "--arm64", ...process.argv.slice(2)]);
