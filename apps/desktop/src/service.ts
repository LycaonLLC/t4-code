import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeProcessRunner, runProcess, type ProcessRunner } from "@t4-code/remote";
import {
  LinuxSystemdUserManager,
  MacLaunchAgentManager,
  NodeServiceFileSystem,
  type ServiceFileSystem,
  type ServiceManager,
  type ServiceRunner,
  type ServiceRunnerResult,
  type ServiceSpec,
} from "@t4-code/service-manager";
export { NodeServiceFileSystem };

export const SERVICE_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "TMPDIR",
] as const;

export type ServiceEnvironmentKey = (typeof SERVICE_ENVIRONMENT_KEYS)[number];

export function createSafeServiceEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const key of SERVICE_ENVIRONMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) continue;
    const value = environment[key];
    if (value !== undefined) safeEnvironment[key] = value;
  }
  return safeEnvironment;
}

const APP_SERVER_PROBE_TIMEOUT_MS = 1_500;
const APP_SERVER_PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

export class OmpAppserverCompatibilityError extends Error {
  readonly code = "omp_appserver_status_json_required" as const;

  constructor() {
    super(
      "Installed OMP is incompatible with this T4 Code build. T4 Code requires `omp appserver status --json`. Update OMP, then choose Check again.",
    );
    this.name = "OmpAppserverCompatibilityError";
    Object.defineProperty(this, "stack", { value: undefined, enumerable: false, configurable: true });
  }
}

export interface OmpExecutableDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAppserverStatus(value: unknown): boolean {
  if (!isRecord(value) || (value.state !== "running" && value.state !== "stopped")) return false;
  if (value.state === "running") {
    if (!isRecord(value.health) || value.health.ok !== true) return false;
    return (
      typeof value.health.hostId === "string" &&
      value.health.hostId.length > 0 &&
      typeof value.health.epoch === "string" &&
      value.health.epoch.length > 0
    );
  }
  return value.reason === "unreachable" || value.reason === "malformed" || value.reason === "failed";
}

type AppserverProbeState = "running" | "stopped" | "incompatible" | false;
async function probesAppserverStatus(
  executable: string,
  environment: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<AppserverProbeState> {
  try {
    const result = await runProcess({
      runner,
      command: executable,
      args: ["appserver", "status", "--json"],
      env: createSafeServiceEnvironment(environment),
      timeoutMs,
    });
    const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
    const stderrBytes = Buffer.byteLength(result.stderr, "utf8");
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      stdoutBytes > maxOutputBytes ||
      stderrBytes > maxOutputBytes ||
      stdoutBytes + stderrBytes > maxOutputBytes
    )
      return false;
    const diagnosticOutput = `${result.stdout}\n${result.stderr}`;
    if (
      /(?:unknown|unrecognized)\s+(?:flag|option)\s*:?\s*--json\b/iu.test(diagnosticOutput) ||
      /flag provided but not defined\s*:\s*-json\b/iu.test(diagnosticOutput)
    )
      return "incompatible";
    if (
      (result.exitCode !== 0 && result.exitCode !== 1) ||
      result.stderr.trim().length > 0
    )
      return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return false;
    }
    if (!isAppserverStatus(parsed) || !isRecord(parsed)) return false;
    return parsed.state === "running" ? "running" : "stopped";
  } catch {
    return false;
  }
}

export async function discoverOmpExecutable(
  options: OmpExecutableDiscoveryOptions = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? APP_SERVER_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? APP_SERVER_PROBE_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return undefined;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024) return undefined;
  const candidates: string[] = [];
  const explicit = environment.OMP_EXECUTABLE;
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit);
  const pathEntries = (environment.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0)
    .slice(0, 64);
  for (const entry of pathEntries) candidates.push(join(entry, "omp"));
  for (const entry of [
    join(home, ".local", "bin", "omp"),
    join(home, "bin", "omp"),
    "/usr/local/bin/omp",
    "/usr/bin/omp",
    "/opt/omp/bin/omp",
  ])
    candidates.push(entry);
  const seen = new Set<string>();
  let incompatible = false;
  for (const candidate of candidates.slice(0, 80)) {
    if (
      seen.has(candidate) ||
      !candidate.startsWith("/") ||
      candidate.includes("\0") ||
      !candidate.endsWith("/omp")
    )
      continue;
    seen.add(candidate);
    try {
      await access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const state = await probesAppserverStatus(candidate, environment, runner, timeoutMs, maxOutputBytes);
    if (state === "running" || state === "stopped") return candidate;
    if (state === "incompatible") incompatible = true;
  }
  if (incompatible) throw new OmpAppserverCompatibilityError();
  return undefined;
}

export async function probeOmpAppserver(
  executable: string,
  options: Omit<OmpExecutableDiscoveryOptions, "homeDirectory"> = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? APP_SERVER_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? APP_SERVER_PROBE_MAX_OUTPUT_BYTES;
  if (!executable.startsWith("/") || !executable.endsWith("/omp")) return false;
  try {
    await access(executable, fsConstants.X_OK);
  } catch {
    return false;
  }
  return (await probesAppserverStatus(executable, environment, runner, timeoutMs, maxOutputBytes)) === "running";
}
export interface NodeServiceRunnerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: ProcessRunner;
}


export class NodeServiceRunner implements ServiceRunner {
  private readonly runner: ProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: NodeServiceRunnerOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.environment = createSafeServiceEnvironment(options.environment);
  }

  async run(argv: readonly string[]): Promise<ServiceRunnerResult> {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("service command is empty");
    const handle = await this.runner.spawn({ command, args, env: this.environment });
    const result = await handle.result;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
}

export function createAppserverServiceManager(options: {
  readonly homeDirectory: string;
  readonly logsDirectory: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly fs: ServiceFileSystem;
  readonly runner?: ServiceRunner;
}): ServiceManager {
  const spec: ServiceSpec = {
    profileId: "default",
    executable: options.executable,
    argv: options.argv,
    logsDirectory: options.logsDirectory,
  };
  const runner = options.runner ?? new NodeServiceRunner();
  if (process.platform === "darwin") {
    return new MacLaunchAgentManager(spec, {
      homeDirectory: options.homeDirectory,
      uid: process.getuid?.() ?? 0,
      fs: options.fs,
      runner,
    });
  }
  return new LinuxSystemdUserManager(spec, {
    homeDirectory: options.homeDirectory,
    fs: options.fs,
    runner,
  });
}
