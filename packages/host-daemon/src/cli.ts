#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAppserver,
  createRemoteAppserver,
  OmpAuthorityBridgeClient,
  profileSocketPath,
  TranscriptSearchIndex,
  type AppserverHandle,
  type AppserverOptions,
} from "@t4-code/host-service";

export const T4_HOST_VERSION = "0.1.30";
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ORIGIN_LIMIT = 32;

export interface HostDaemonConfig {
  readonly ompExecutable: string;
  readonly profileId: string;
  readonly stateRoot: string;
  readonly remote?: {
    readonly mode: "direct" | "serve";
    readonly address: string;
    readonly port: number;
    readonly origins: readonly string[];
    readonly trustedServeProxy: boolean;
  };
}

export interface HostDaemonPaths {
  readonly profileStateRoot: string;
  readonly hostIdPath: string;
  readonly attentionOutcomePath: string;
  readonly transcriptSearchPath: string;
  readonly remoteStateRoot: string;
  readonly socketPath: string;
}

function value(argv: readonly string[], index: number, flag: string): string {
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
}

function boundedOrigin(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "--remote-origin must be an HTTP origin without credentials, path, query, or fragment",
    );
  return url.origin;
}

export function parseHostDaemonArgs(argv: readonly string[], home = homedir()): HostDaemonConfig {
  if (argv[0] !== "serve") throw new Error("t4-host requires the serve action");
  let ompExecutable: string | undefined;
  let profileId = "default";
  let stateRoot = join(home, ".t4-code", "host");
  let remoteMode: "direct" | "serve" | undefined;
  let remoteAddress: string | undefined;
  let remotePort = 8787;
  let trustedServeProxy = false;
  const origins: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--omp") ompExecutable = value(argv, index++, flag);
    else if (flag === "--profile") profileId = value(argv, index++, flag);
    else if (flag === "--state-root") stateRoot = value(argv, index++, flag);
    else if (flag === "--remote-mode") {
      const mode = value(argv, index++, flag);
      if (mode !== "direct" && mode !== "serve")
        throw new Error("--remote-mode must be direct or serve");
      remoteMode = mode;
    } else if (flag === "--remote-address") remoteAddress = value(argv, index++, flag);
    else if (flag === "--remote-port") {
      remotePort = Number(value(argv, index++, flag));
      if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535)
        throw new Error("--remote-port must be between 1 and 65535");
    } else if (flag === "--remote-origin") {
      if (origins.length >= ORIGIN_LIMIT) throw new Error("too many --remote-origin values");
      origins.push(boundedOrigin(value(argv, index++, flag)));
    } else if (flag === "--trusted-serve-proxy") trustedServeProxy = true;
    else throw new Error(`unsupported t4-host argument: ${flag}`);
  }
  if (!ompExecutable || !isAbsolute(ompExecutable))
    throw new Error("--omp must name an absolute executable path");
  if (!PROFILE.test(profileId)) throw new Error("--profile is invalid");
  if (!isAbsolute(stateRoot)) throw new Error("--state-root must be absolute");
  if (!remoteMode && (remoteAddress || origins.length || trustedServeProxy || remotePort !== 8787))
    throw new Error("remote flags require --remote-mode");
  if (remoteMode && !remoteAddress) throw new Error("remote mode requires --remote-address");
  if (remoteMode === "serve" && remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")
    throw new Error("serve mode requires a loopback address");
  if (remoteMode === "serve" && !trustedServeProxy)
    throw new Error("serve mode requires --trusted-serve-proxy");
  if (remoteMode === "direct" && trustedServeProxy)
    throw new Error("trusted Serve proxy is invalid in direct mode");
  return {
    ompExecutable: resolve(ompExecutable),
    profileId,
    stateRoot: resolve(stateRoot),
    ...(remoteMode
      ? {
          remote: {
            mode: remoteMode,
            address: remoteAddress!,
            port: remotePort,
            origins,
            trustedServeProxy,
          },
        }
      : {}),
  };
}

export function hostDaemonPaths(
  config: Pick<HostDaemonConfig, "profileId" | "stateRoot">,
): HostDaemonPaths {
  const profileKey = createHash("sha256")
    .update(config.profileId, "utf8")
    .digest("hex")
    .slice(0, 24);
  const profileStateRoot = join(config.stateRoot, "profiles", profileKey);
  return {
    profileStateRoot,
    hostIdPath: join(profileStateRoot, "host-id"),
    attentionOutcomePath: join(profileStateRoot, "attention-outcomes.json"),
    transcriptSearchPath: join(profileStateRoot, "transcript-search.sqlite"),
    remoteStateRoot: join(profileStateRoot, "remote"),
    socketPath: profileSocketPath(config.profileId),
  };
}

export interface HostDaemonDependencies {
  readonly createBridge?: (config: HostDaemonConfig) => OmpAuthorityBridgeClient;
  readonly createTranscriptSearch?: (path: string) => TranscriptSearchIndex;
  readonly createLocal?: (options: AppserverOptions) => AppserverHandle;
  readonly createRemote?: typeof createRemoteAppserver;
  readonly onSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
}

export async function runHostDaemon(
  config: HostDaemonConfig,
  dependencies: HostDaemonDependencies = {},
): Promise<void> {
  const paths = hostDaemonPaths(config);
  await mkdir(paths.profileStateRoot, { recursive: true, mode: 0o700 });
  const bridge =
    dependencies.createBridge?.(config) ??
    new OmpAuthorityBridgeClient({
      executable: config.ompExecutable,
      environment: { OMP_PROFILE: config.profileId },
    });
  await bridge.start();
  try {
    const authorities = bridge.createAuthorities();
    const hostInfo = await authorities.hostInfo();
    const transcriptSearchAuthority =
      dependencies.createTranscriptSearch?.(paths.transcriptSearchPath) ??
      new TranscriptSearchIndex(paths.transcriptSearchPath);
    const identity = bridge.identity;
    const options: AppserverOptions = {
      ...identity,
      appserverVersion: T4_HOST_VERSION,
      appserverBuild: process.env.T4_HOST_BUILD?.slice(0, 128) || "source",
      socketPath: paths.socketPath,
      hostIdPath: paths.hostIdPath,
      attentionOutcomePath: paths.attentionOutcomePath,
      sessionAuthority: authorities.sessionAuthority,
      discovery: authorities.discovery,
      operationsAuthority: authorities.operationsAuthority,
      usageAuthority: authorities.usageAuthority,
      transcriptSearchAuthority,
      projectRootForProject: authorities.projectRootForProject,
      lockCheck: authorities.lockCheck,
      lockStatus: authorities.lockStatus,
      transcriptImageRoot: hostInfo.transcriptImageRoot,
      rpcChildInvocation: { executable: config.ompExecutable, prefixArgv: [] },
      ...(process.platform === "darwin"
        ? {
            projectRevealer: async (root: string): Promise<boolean> => {
              const child = Bun.spawn(["/usr/bin/open", "-R", root], {
                stdout: "ignore",
                stderr: "ignore",
              });
              return (await child.exited) === 0;
            },
          }
        : {}),
    };
    let appserver: AppserverHandle;
    try {
      appserver = config.remote
        ? await (dependencies.createRemote ?? createRemoteAppserver)({
            stateDir: paths.remoteStateRoot,
            remoteEndpoint: {
              address: config.remote.address,
              port: config.remote.port,
              originAllowlist: config.remote.origins,
              serveProxy: config.remote.mode === "serve",
              trustedServeProxy: config.remote.trustedServeProxy,
            },
            appserver: options,
          })
        : (dependencies.createLocal ?? createAppserver)(options);
    } catch (error) {
      await Promise.resolve(transcriptSearchAuthority.close()).catch(() => undefined);
      throw error;
    }
    const stopped = Promise.withResolvers<void>();
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void appserver.stop().then(stopped.resolve, stopped.reject);
    };
    const onSignal = dependencies.onSignal ?? ((signal, listener) => process.on(signal, listener));
    const removeSignal =
      dependencies.removeSignal ?? ((signal, listener) => process.off(signal, listener));
    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
    try {
      await appserver.start();
      await stopped.promise;
    } finally {
      removeSignal("SIGINT", stop);
      removeSignal("SIGTERM", stop);
      if (!stopping) await appserver.stop().catch(() => undefined);
    }
  } finally {
    await bridge.stop();
  }
}

async function main(): Promise<void> {
  try {
    await runHostDaemon(parseHostDaemonArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `t4-host error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
