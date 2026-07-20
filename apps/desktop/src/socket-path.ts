import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeLocalProfileId } from "@t4-code/protocol/desktop-ipc";

export interface UnixSocketPolicy {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly profileId?: string;
}

export function localSocketPath(policy: UnixSocketPolicy = {}): string {
  const platform = policy.platform ?? process.platform;
  const home = policy.homeDirectory ?? homedir();
  const profileId = decodeLocalProfileId(policy.profileId ?? "default");
  const name = profileId === "default"
    ? "appserver.sock"
    : `appserver-profile-${createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 24)}.sock`;
  if (platform === "darwin") return join(home, ".omp", "run", name);
  if (platform !== "linux") throw new Error("the local T4 host is supported only on Linux and macOS");
  const configuredRuntime = policy.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR;
  const runtime = configuredRuntime === undefined || configuredRuntime.length === 0
    ? join(home, ".omp", "run")
    : configuredRuntime;
  if (!runtime.startsWith("/")) throw new Error("XDG_RUNTIME_DIR must be an absolute path");
  return join(runtime, "omp", name);
}
