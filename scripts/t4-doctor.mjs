import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const help = `Usage: node scripts/t4-doctor.mjs [--json]

Run read-only, redacted checks for the T4 Code source toolchain, compatible
OMP authority bridge, local T4 host, profiles, and optional Tailscale access.

Options:
  --json  Print a machine-readable report suitable for a redacted bug report
  --help  Show this help`;

export function parseDoctorArguments(args) {
  let json = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") return { help: true, json: false };
    else throw new Error(`unknown option: ${argument}`);
  }
  return { help: false, json };
}

export async function runDoctorCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseDoctorArguments(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid doctor option");
    console.error(help);
    return 2;
  }
  if (options.help) {
    console.log(help);
    return 0;
  }

  const checks = [
    commandCheck("node", ["--version"]),
    commandCheck("pnpm", ["--version"]),
    commandCheck("flutter", ["--version", "--machine"]),
    commandCheck(process.env.OMP_EXECUTABLE?.trim() || "omp", ["--version"]),
  ];
  const report = { schemaVersion: 1, ok: checks.every((check) => check.ok), checks };
  console.log(options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

function commandCheck(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { command, ok: false, detail: result.error.code === "ENOENT" ? "not found" : "unavailable" };
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/u)[0]?.slice(0, 200) ?? "";
  return { command, ok: result.status === 0, detail: output || `exit ${result.status}` };
}

function formatDoctorReport(report) {
  const lines = report.checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.command}: ${check.detail}`);
  return [`T4 Code Flutter environment: ${report.ok ? "ready" : "needs attention"}`, ...lines].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runDoctorCli();
}
