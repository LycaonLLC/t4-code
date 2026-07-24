import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_BASE_HREF = "/demo/";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export function buildDemo(
  repoRoot = resolve(import.meta.dirname, ".."),
  runCommand = run,
) {
  const output = resolve(repoRoot, "apps/site/dist/demo");
  runCommand(
    "pnpm",
    ["--filter", "@t4-code/web", "exec", "vp", "build", "--mode", "demo", "--outDir", output],
    repoRoot,
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    buildDemo();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
