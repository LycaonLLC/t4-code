import {
  decodeProjectFileSearchArguments,
  decodeProjectFileSearchResult,
  hostId,
  sessionId,
  type ProjectFileSearchArguments,
  type ProjectFileSearchResult,
} from "@t4-code/protocol";
import type { CommandResult } from "@t4-code/protocol/desktop-ipc";
import type { DesktopRuntimeController } from "./desktop-runtime.ts";

const FEATURE = "files.search";
const CAPABILITY = "files.list";

export interface ProjectFileSearchAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

export type ProjectFileSearchRuntime = Pick<DesktopRuntimeController, "command" | "getSnapshot">;

export class ProjectFileSearchError extends Error {
  readonly code: "invalid" | "offline" | "unsupported" | "command";

  constructor(code: ProjectFileSearchError["code"], message: string) {
    super(message);
    this.name = "ProjectFileSearchError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }
}

function commandFailureCode(result: CommandResult): string {
  const code = result.error?.code;
  return typeof code === "string" && code.length > 0 ? code.slice(0, 128) : "command_failed";
}

export async function searchProjectFiles(
  runtime: ProjectFileSearchRuntime,
  address: ProjectFileSearchAddress,
  args: ProjectFileSearchArguments,
): Promise<ProjectFileSearchResult> {
  let normalized: ProjectFileSearchArguments;
  try {
    normalized = decodeProjectFileSearchArguments({ ...args, query: args.query.trim() });
  } catch {
    throw new ProjectFileSearchError("invalid", "project file search arguments are invalid");
  }
  const snapshot = runtime.getSnapshot();
  if (snapshot.connections.get(address.targetId) !== "connected") {
    throw new ProjectFileSearchError("offline", "project file search host is offline");
  }
  const metadata = snapshot.hosts.get(address.hostId);
  if (
    metadata === undefined ||
    snapshot.targetHosts.get(address.targetId) !== address.hostId ||
    !metadata.grantedFeatures.includes(FEATURE) ||
    !metadata.grantedCapabilities.includes(CAPABILITY)
  ) {
    throw new ProjectFileSearchError("unsupported", "project file search is unavailable");
  }
  const result = await runtime.command(address.targetId, {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command: "files.search",
    args: { ...normalized },
  });
  if (!result.accepted) {
    const code = commandFailureCode(result);
    if (code === "unsupported" || code === "feature_required" || code === "capability_denied") {
      throw new ProjectFileSearchError("unsupported", "project file search is unavailable");
    }
    throw new ProjectFileSearchError("command", `project file search failed (${code})`);
  }
  try {
    return decodeProjectFileSearchResult(result.result);
  } catch {
    throw new ProjectFileSearchError("command", "project file search returned an invalid result");
  }
}

export type {
  ProjectFileSearchArguments,
  ProjectFileSearchMatch,
  ProjectFileSearchResult,
} from "@t4-code/protocol";
