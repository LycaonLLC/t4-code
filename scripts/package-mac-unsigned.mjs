import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runElectronBuilder } from "./run-electron-builder.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

if (process.platform !== "darwin") {
  console.error(`package:mac:unsigned requires macOS (darwin); current platform is ${process.platform}`);
  process.exit(1);
}

const prepackage = spawnSync("pnpm", ["prepackage"], {
  cwd: repoRoot,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", T4_MACOS_SIGNED_BUILD: "0" },
  stdio: "inherit",
});
if (prepackage.error) throw prepackage.error;
if (prepackage.status !== 0) process.exit(prepackage.status ?? 1);

process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
process.env.T4_MACOS_SIGNED_BUILD = "0";
process.exitCode = runElectronBuilder(["--mac", "--arm64", ...process.argv.slice(2)]);
