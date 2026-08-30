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
  type ServiceInspection,
  type ServiceManager,
  type ServiceRunner,
  type ServiceRunnerResult,
  type ServiceSpec,
} from "@t4-code/service-manager";
import { decodeLocalProfileId } from "@t4-code/protocol/desktop-ipc";
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

const OMP_PROBE_TIMEOUT_MS = 3_000;
const OMP_PROBE_MAX_OUTPUT_BYTES = 4 * 1024;
export const OFFICIAL_OMP_VERSION = "18.0.11";

export class OmpRuntimeCompatibilityError extends Error {
  readonly code = "omp_official_runtime_required" as const;

  constructor() {
    super(
      `Installed OMP is incompatible with this T4 Code build. T4 Code requires unmodified official OMP ${OFFICIAL_OMP_VERSION}. Update OMP, then choose Check again.`,
    );
    this.name = "OmpRuntimeCompatibilityError";
    Object.defineProperty(this, "stack", {
      value: undefined,
      enumerable: false,
      configurable: true,
    });
  }
}

export interface OmpExecutableDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface T4HostExecutableDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly packagedExecutable?: string;
}

export interface OmpRuntimeProbeOptions extends Omit<
  OmpExecutableDiscoveryOptions,
  "homeDirectory"
> {}

export type PathOmpCompatibility =
  | "compatible"
  | "incompatible"
  | "missing"
  | "mixed"
  | "unavailable";

type OmpRuntimeProbeState = "compatible" | "incompatible" | false;

async function probesOfficialOmpRuntime(
  executable: string,
  environment: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<OmpRuntimeProbeState> {
  try {
    const result = await runProcess({
      runner,
      command: executable,
      args: ["--version"],
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
    if (result.exitCode !== 0 || result.stderr.trim().length > 0) return false;
    return result.stdout.trim() === `omp/${OFFICIAL_OMP_VERSION}`
      ? "compatible"
      : "incompatible";
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
  const timeoutMs = options.timeoutMs ?? OMP_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? OMP_PROBE_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return undefined;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024)
    return undefined;
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
    const state = await probesOfficialOmpRuntime(
      candidate,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
    );
    if (state === "compatible") return candidate;
    if (state === "incompatible") incompatible = true;
  }
  if (incompatible) throw new OmpRuntimeCompatibilityError();
  return undefined;
}

export async function discoverT4HostExecutable(
  options: T4HostExecutableDiscoveryOptions = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const candidates = [
    options.packagedExecutable,
    environment.T4_HOST_EXECUTABLE,
    ...(environment.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .slice(0, 64)
      .map((entry) => join(entry, "t4-host")),
    join(home, ".local", "bin", "t4-host"),
    join(home, "bin", "t4-host"),
    "/usr/local/bin/t4-host",
    "/usr/bin/t4-host",
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate ||
      seen.has(candidate) ||
      !candidate.startsWith("/") ||
      candidate.includes("\0") ||
      !candidate.endsWith("/t4-host")
    )
      continue;
    seen.add(candidate);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * Check every `omp` command on PATH. T4 may have its own compatible bundled
 * runtime while another shell or app launch path selects a different official
 * OMP version.
 */
export async function inspectPathOmpCompatibility(
  options: Omit<OmpExecutableDiscoveryOptions, "homeDirectory"> = {},
): Promise<PathOmpCompatibility> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? OMP_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? OMP_PROBE_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return "unavailable";
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024)
    return "unavailable";

  const entries = (environment.PATH ?? "")
    .split(":")
    .filter((entry) => entry.startsWith("/") && !entry.includes("\0"))
    .slice(0, 64);
  const seen = new Set<string>();
  let compatible = 0;
  let incompatible = 0;
  let unavailable = 0;
  for (const entry of entries) {
    const candidate = join(entry, "omp");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const state = await probesOfficialOmpRuntime(
      candidate,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
    );
    if (state === "compatible") compatible += 1;
    else if (state === "incompatible") incompatible += 1;
    else unavailable += 1;
  }
  if (compatible > 0 && (incompatible > 0 || unavailable > 0)) return "mixed";
  if (compatible > 0) return "compatible";
  if (incompatible > 0) return "incompatible";
  if (unavailable > 0) return "unavailable";
  return "missing";
}

export async function probeOmpRuntime(
  executable: string,
  options: OmpRuntimeProbeOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? OMP_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? OMP_PROBE_MAX_OUTPUT_BYTES;
  if (!executable.startsWith("/") || !executable.endsWith("/omp")) return false;
  try {
    await access(executable, fsConstants.X_OK);
  } catch {
    return false;
  }
  return (
    (await probesOfficialOmpRuntime(
      executable,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
    )) === "compatible"
  );
}

export interface AppserverServiceRepairOptions {
  readonly attempts?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly retryDelayMs?: number;
}

/**
 * Reconcile a T4-owned appserver definition and its service registration.
 *
 * The first pass uses the smallest needed action. A second pass performs a
 * full install transaction, which safely replaces a stale LaunchAgent path
 * and recovers when launchd was still removing an older registration.
 */
export async function repairAppserverService(
  manager: ServiceManager,
  options: AppserverServiceRepairOptions = {},
): Promise<ServiceInspection> {
  const attempts = options.attempts ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 150;
  const delay = options.delay ?? (
    (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  );
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3)
    throw new Error("invalid appserver service repair attempt count");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000)
    throw new Error("invalid appserver service repair delay");

  let inspection = await manager.inspect();
  if (
    inspection.definition === "current" &&
    (inspection.service === "running" || inspection.service === "starting")
  ) return inspection;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (attempt === 0 && inspection.definition === "current") await manager.start();
      else await manager.install();
      inspection = await manager.inspect();
      if (
        inspection.definition === "current" &&
        (inspection.service === "running" || inspection.service === "starting")
      ) return inspection;
      lastError = new Error(
        `appserver service repair did not start the service (${inspection.diagnostics.slice(0, 512)})`,
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 >= attempts) break;
    await delay(retryDelayMs);
    inspection = await manager.inspect();
    if (
      inspection.definition === "current" &&
      (inspection.service === "running" || inspection.service === "starting")
    ) return inspection;
  }
  throw lastError ?? new Error("appserver service repair failed");
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
  readonly profileId?: string;
  readonly homeDirectory: string;
  readonly logsDirectory: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly fs: ServiceFileSystem;
  readonly runner?: ServiceRunner;
}): ServiceManager {
  const profileId = decodeLocalProfileId(options.profileId ?? "default");
  const spec: ServiceSpec = {
    profileId,
    executable: options.executable,
    argv: options.argv,
    logsDirectory: options.logsDirectory,
    // Pin both default and named services explicitly. A graphical/login service
    // manager can retain an imported OMP_PROFILE from an unrelated shell; an
    // omitted value would let that ambient profile silently hijack T4's
    // default appserver.
    environment: { OMP_PROFILE: profileId },
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
