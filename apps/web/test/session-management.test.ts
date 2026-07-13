import { describe, expect, it } from "vite-plus/test";
import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  commandId,
  confirmationId,
  hostId,
  projectId,
  revision,
  sessionId,
  type CatalogFrame,
  type SessionRef,
} from "@t4-code/protocol";
import type {
  CommandRequest,
  CommandResult,
  ConfirmRequest,
  ConfirmResult,
  RendererServerFrameEvent,
} from "@t4-code/protocol/desktop-ipc";

import {
  archiveLiveSession,
  deleteLiveSession,
  managementCommandSupport,
  renameLiveSession,
  restoreLiveSession,
  sessionCreateSupport,
  sessionIsArchived,
  sessionIsWorking,
} from "../src/features/session-runtime/session-management.ts";
import type { LiveSessionAddress } from "../src/platform/live-workspace.ts";

const ADDRESS: LiveSessionAddress = {
  targetId: "target-1",
  hostId: "host-1",
  sessionId: "session-1",
};
const KEY = `${ADDRESS.hostId}\u0000${ADDRESS.sessionId}`;

function ref(
  options: { archived?: boolean; revision?: string; status?: string; title?: string } = {},
): SessionRef {
  return {
    hostId: hostId(ADDRESS.hostId),
    sessionId: sessionId(ADDRESS.sessionId),
    project: { projectId: projectId("project-1"), name: "Working folder" },
    revision: revision(options.revision ?? "revision-1"),
    title: options.title ?? "Session title",
    status: options.status ?? "idle",
    updatedAt: "2026-07-13T00:00:00.000Z",
    liveState: { phase: options.status === "active" ? "running" : "idle" },
    ...(options.archived ? { archivedAt: "2026-07-13T01:00:00.000Z" } : {}),
  } as SessionRef;
}

function catalog(): CatalogFrame {
  return {
    v: "omp-app/1",
    type: "catalog",
    hostId: hostId(ADDRESS.hostId),
    revision: revision("catalog-1"),
    items: [
      "session.create",
      "session.rename",
      "session.archive",
      "session.restore",
      "session.delete",
    ].map(
      (name) => ({
        id: `command-${name}` as never,
        kind: "command" as const,
        name,
        supported: true,
        capabilities: ["sessions.manage"],
      }),
    ),
  };
}

class FakeManagementController {
  readonly commands: CommandRequest["intent"][] = [];
  readonly controllerLeaseCommands: CommandRequest["intent"][] = [];
  readonly confirms: ConfirmRequest[] = [];
  private readonly snapshotListeners = new Set<(snapshot: DesktopRuntimeSnapshot) => void>();
  private readonly frameListeners = new Set<(event: RendererServerFrameEvent) => void>();
  private readonly sessionIndex = new Map<string, SessionRef>();
  private pendingMutation: "rename" | "archive" | "restore" | "delete" | null = null;
  private pendingName = "";
  private deleteGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  private sequence = 0;

  constructor(initial: SessionRef = ref()) {
    this.sessionIndex.set(KEY, initial);
  }

  getSnapshot(): DesktopRuntimeSnapshot {
    return {
      version: 1,
      platform: "linux",
      desktopVersion: "test",
      startState: "started",
      targets: new Map(),
      connections: new Map([[ADDRESS.targetId, "connected"]]),
      targetHosts: new Map([[ADDRESS.targetId, ADDRESS.hostId]]),
      hosts: new Map([
        [
          ADDRESS.hostId,
          {
            targetId: ADDRESS.targetId,
            hostId: ADDRESS.hostId,
            ompVersion: "test",
            ompBuild: "test",
            appserverVersion: "test",
            appserverBuild: "test",
            epoch: "epoch-1",
            grantedCapabilities: ["sessions.manage"],
            grantedFeatures: [],
            negotiatedLimits: {},
            authentication: "local",
            resumed: false,
          },
        ],
      ]),
      catalogs: new Map([[ADDRESS.hostId, catalog()]]),
      settings: new Map(),
      projection: {
        version: 1,
        sessions: new Map(),
        sessionIndex: this.sessionIndex,
        sessionIndexMetadata: new Map(),
        sessionDeltaCursors: new Map(),
        lru: [],
        freshness: "fresh",
      },
      runtimeErrors: [],
    };
  }

  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeFrames(
    _filter: unknown,
    listener: (event: RendererServerFrameEvent) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async command(_targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.commands.push(intent);
    this.sequence += 1;
    const base = {
      targetId: ADDRESS.targetId,
      requestId: `request-${this.sequence}`,
      commandId: `command-${this.sequence}`,
      accepted: true,
    } as const;
    if (intent.command === "session.rename") {
      this.pendingMutation = "rename";
      this.pendingName = String(intent.args?.name ?? "");
      return { ...base, result: { renamed: true } };
    }
    if (intent.command === "session.archive") {
      this.pendingMutation = "archive";
      return { ...base, result: { archived: true } };
    }
    if (intent.command === "session.restore") {
      this.pendingMutation = "restore";
      return { ...base, result: { restored: true } };
    }
    if (intent.command === "session.delete") {
      this.pendingMutation = "delete";
      this.deleteGate = Promise.withResolvers<void>();
      const current = this.sessionIndex.get(KEY);
      this.emitFrame({
        v: "omp-app/1",
        type: "confirmation",
        confirmationId: confirmationId("delete-confirmation"),
        commandId: commandId(base.commandId),
        hostId: hostId(ADDRESS.hostId),
        sessionId: sessionId(ADDRESS.sessionId),
        commandHash: "sha256:delete",
        revision: current?.revision ?? revision("missing"),
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: "session.delete",
      });
      await this.deleteGate.promise;
      return { ...base, result: { deleted: true } };
    }
    if (intent.command === "session.list") {
      this.applyPendingMutation();
      this.emitSnapshot();
      return base;
    }
    throw new Error(`unexpected command: ${intent.command}`);
  }

  async commandWithControllerLease(
    targetId: string,
    intent: CommandRequest["intent"],
  ): Promise<CommandResult> {
    this.controllerLeaseCommands.push(intent);
    return this.command(targetId, intent);
  }

  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    this.confirms.push(request);
    this.deleteGate?.resolve();
    return {
      targetId: request.targetId,
      requestId: "confirm-request",
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted: true,
    };
  }

  private emitFrame(frame: RendererServerFrameEvent["frame"]): void {
    const event = { targetId: ADDRESS.targetId, frame };
    for (const listener of this.frameListeners) listener(event);
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private applyPendingMutation(): void {
    const current = this.sessionIndex.get(KEY);
    if (current === undefined || this.pendingMutation === null) return;
    if (this.pendingMutation === "delete") {
      this.sessionIndex.delete(KEY);
    } else {
      const alreadyDesired =
        (this.pendingMutation === "archive" && sessionIsArchived(current)) ||
        (this.pendingMutation === "restore" && !sessionIsArchived(current));
      const nextRevision = alreadyDesired
        ? current.revision
        : revision(`${String(current.revision)}-next`);
      const next = {
        ...current,
        revision: nextRevision,
        ...(this.pendingMutation === "rename" ? { title: this.pendingName } : {}),
      } as SessionRef & { archivedAt?: string };
      if (this.pendingMutation === "archive") {
        next.archivedAt = "2026-07-13T02:00:00.000Z";
      } else if (this.pendingMutation === "restore") {
        delete next.archivedAt;
      }
      this.sessionIndex.set(KEY, next);
    }
    this.pendingMutation = null;
  }
}

function controller(fake: FakeManagementController): DesktopRuntimeController {
  return fake as unknown as DesktopRuntimeController;
}

describe("session management authority helpers", () => {
  it("offers creation only when the live host catalog advertises session.create", () => {
    const snapshot = new FakeManagementController().getSnapshot();
    const address = { targetId: ADDRESS.targetId, hostId: ADDRESS.hostId, projectId: "project-1" };
    expect(sessionCreateSupport(snapshot, address)).toEqual({ supported: true, reason: null });

    const catalogWithoutCreate = catalog();
    const missing = {
      ...snapshot,
      catalogs: new Map([
        [
          ADDRESS.hostId,
          { ...catalogWithoutCreate, items: catalogWithoutCreate.items.filter((item) => item.name !== "session.create") },
        ],
      ]),
    } as DesktopRuntimeSnapshot;
    expect(sessionCreateSupport(missing, address)).toEqual({
      supported: false,
      reason: "This host does not offer session creation yet",
    });
  });

  it("renames through the controller lease path, then refreshes the authoritative list", async () => {
    const fake = new FakeManagementController();
    await renameLiveSession(controller(fake), ADDRESS, "  Better title  ");
    expect(fake.controllerLeaseCommands).toHaveLength(1);
    expect(fake.controllerLeaseCommands[0]).toMatchObject({
      command: "session.rename",
      expectedRevision: "revision-1",
      args: { name: "Better title" },
    });
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.rename",
      "session.list",
    ]);
    expect(fake.getSnapshot().projection.sessionIndex.get(KEY)?.title).toBe("Better title");
  });

  it("archives and restores directly, including already-converged idempotent states", async () => {
    const current = new FakeManagementController();
    await archiveLiveSession(controller(current), ADDRESS);
    expect(current.controllerLeaseCommands).toHaveLength(0);
    expect(sessionIsArchived(current.getSnapshot().projection.sessionIndex.get(KEY))).toBe(true);
    await restoreLiveSession(controller(current), ADDRESS);
    expect(sessionIsArchived(current.getSnapshot().projection.sessionIndex.get(KEY))).toBe(false);

    const alreadyArchived = new FakeManagementController(ref({ archived: true }));
    await expect(archiveLiveSession(controller(alreadyArchived), ADDRESS)).resolves.toBeUndefined();
    const alreadyCurrent = new FakeManagementController();
    await expect(restoreLiveSession(controller(alreadyCurrent), ADDRESS)).resolves.toBeUndefined();
  });

  it("auto-approves only the correlated delete challenge and waits for list absence", async () => {
    const fake = new FakeManagementController();
    await deleteLiveSession(controller(fake), ADDRESS);
    expect(fake.confirms).toEqual([
      expect.objectContaining({
        targetId: ADDRESS.targetId,
        confirmationId: "delete-confirmation",
        hostId: ADDRESS.hostId,
        sessionId: ADDRESS.sessionId,
        decision: "approve",
      }),
    ]);
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.delete",
      "session.list",
    ]);
    expect(fake.getSnapshot().projection.sessionIndex.has(KEY)).toBe(false);
  });

  it("blocks destructive actions while the host reports active work", async () => {
    const fake = new FakeManagementController(ref({ status: "active" }));
    const snapshot = fake.getSnapshot();
    expect(managementCommandSupport(snapshot, ADDRESS, "session.archive")).toEqual({
      supported: false,
      reason: "Stop the session before archiving or deleting it",
    });
    await expect(archiveLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      "Stop the session before archiving or deleting it",
    );
    await expect(deleteLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      "Stop the session before archiving or deleting it",
    );
    expect(fake.commands).toHaveLength(0);
  });

  it("treats queued, waiting, streaming, and compacting host state as active work", () => {
    for (const candidate of [
      { ...ref(), pendingApproval: true },
      { ...ref(), pendingUserInput: true },
      { ...ref(), liveState: { isStreaming: true } },
      { ...ref(), liveState: { isCompacting: true } },
      { ...ref(), liveState: { phase: "waiting" } },
      { ...ref(), liveState: { phase: "awaiting_input" } },
      { ...ref(), liveState: { queuedMessageCount: 1 } },
      { ...ref(), liveState: { queuedMessages: ["next"] } },
    ]) {
      expect(sessionIsWorking(candidate as SessionRef)).toBe(true);
    }
    expect(sessionIsWorking(ref())).toBe(false);
  });
});
