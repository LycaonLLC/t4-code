import {
  type CommandFrame,
  type HostId,
  type Revision,
  type ServerFrame,
  type SessionId,
  type SessionRef,
} from "@t4-code/protocol";
import { fixtureSettings } from "./fixture-catalog.ts";
import { branded, type Cursor } from "./fixture-sessions.ts";
import type { ScenarioSeed } from "./seeds.ts";

const V = "omp-app/1" as const;

interface CommandSideFrameIds {
  readonly v: typeof V;
  readonly hostId: HostId;
  readonly sessionId: SessionId;
  readonly cursor: Cursor;
  readonly revision: Revision;
}

export function buildCommandSideFrames(
  frame: CommandFrame,
  ids: CommandSideFrameIds,
  session: SessionRef,
  seed: ScenarioSeed,
): ServerFrame[] {
  let additive: unknown;
  if (frame.command === "host.watch")
    additive = { ...ids, type: "host.watch", watchId: "watch-fixture", state: "started" };
  else if (
    frame.command === "controller.lease.acquire" ||
    frame.command === "controller.lease.renew" ||
    frame.command === "controller.lease.release"
  )
    additive = {
      ...ids,
      type: "lease",
      leaseId: "lease-fixture",
      kind: "controller",
      state: frame.command.endsWith("release")
        ? "released"
        : frame.command.endsWith("renew")
          ? "renewed"
          : "acquired",
      owner: "fixture-device",
      expiresAt: new Date(Date.parse(seed.baseTime) + 60_000).toISOString(),
    };
  else if (
    frame.command === "prompt.lease.acquire" ||
    frame.command === "prompt.lease.renew" ||
    frame.command === "prompt.lease.release"
  )
    additive = {
      ...ids,
      type: "prompt.lease",
      leaseId: "lease-fixture",
      kind: "prompt",
      state: frame.command.endsWith("release")
        ? "released"
        : frame.command.endsWith("renew")
          ? "renewed"
          : "acquired",
      owner: "fixture-device",
      expiresAt: new Date(Date.parse(seed.baseTime) + 60_000).toISOString(),
    };
  else if (frame.command === "session.watch")
    additive = [
      { ...ids, type: "session.watch", watchId: "watch-fixture", state: "started" },
      { ...ids, type: "session.state", state: "ready" },
      { ...ids, type: "session.delta", upsert: session },
      { ...ids, type: "session.delta", remove: branded<SessionId>("session-removed") },
    ];
  else if (frame.command === "agent.cancel")
    additive = [
      { ...ids, type: "agent.lifecycle", agentId: "agent-fixture", lifecycle: "cancelled" },
      { ...ids, type: "agent.progress", agentId: "agent-fixture", progress: 1 },
      { ...ids, type: "agent.transcript", agentId: "agent-fixture", entries: [] },
    ];
  else if (frame.command === "files.list")
    additive = { ...ids, type: "files.list", path: "src", entries: [] };
  else if (frame.command === "files.diff")
    additive = { ...ids, type: "files.diff", path: "src/file.ts", diff: "" };
  else if (frame.command === "audit.tail")
    additive = [
      { v: V, type: "audit.tail", hostId: ids.hostId, cursor: ids.cursor, events: [] },
      {
        v: V,
        type: "audit.event",
        hostId: ids.hostId,
        cursor: ids.cursor,
        event: {
          eventId: "operation-fixture",
          hostId: ids.hostId,
          action: "fixture.read",
          actor: "fixture",
          timestamp: seed.baseTime,
        },
      },
    ];
  else if (frame.command === "settings.read")
    additive = {
      v: V,
      type: "settings",
      hostId: ids.hostId,
      revision: ids.revision,
      settings: fixtureSettings(),
    };
  else if (frame.command === "preview.launch")
    additive = {
      ...ids,
      type: "preview.launch",
      previewId: "preview-fixture",
      url: "http://127.0.0.1/fixture",
      revision: ids.revision,
    };
  else if (frame.command === "preview.state")
    additive = { ...ids, type: "preview.state", previewId: "preview-fixture", state: "ready" };
  else if (frame.command === "preview.navigate")
    additive = {
      ...ids,
      type: "preview.navigation",
      previewId: "preview-fixture",
      url: "http://127.0.0.1/fixture",
    };
  else if (frame.command === "preview.capture")
    additive = {
      ...ids,
      type: "preview.capture",
      previewId: "preview-fixture",
      content: "",
      encoding: "base64",
      mimeType: "text/plain",
    };

  if (Array.isArray(additive)) return additive as ServerFrame[];
  return additive === undefined ? [] : [additive as ServerFrame];
}
