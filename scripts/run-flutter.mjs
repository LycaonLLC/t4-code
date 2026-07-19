import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const fixtureUrl = process.env.T4_FIXTURE_URL?.trim();
if (
  fixtureUrl &&
  !args.some((argument) => argument.startsWith("--dart-define=T4_FIXTURE_URL="))
) {
  args.push(`--dart-define=T4_FIXTURE_URL=${fixtureUrl}`);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("flutter", ["run", ...args], {
  cwd: resolve(repositoryRoot, "apps/flutter"),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Unable to launch Flutter: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
