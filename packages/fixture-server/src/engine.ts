import {
  AppWireError,
  COMMAND_DESCRIPTORS,
  decodeClientFrame,
  decodeServerFrame,
  type ClientFrame,
  type CommandFrame,
  type ConfirmationId,
  type DurableEntry,
  type EntryId,
  type HostId,
  type LiveEventFrame,
  type ProjectId,
  type Revision,
  type ServerFrame,
  type SessionId,
} from "@t4-code/protocol";
import { canonicalSha256, type ScenarioSeed } from "./seeds.ts";

const V = "omp-app/1" as const;
export const MAX_QUEUE = 128;
export const MAX_JOURNAL = 256;
const MAX_HISTORY_SNAPSHOT = 900;

type Cursor = { epoch: string; seq: number };
type JournalFrame = Extract<ServerFrame, { type: "entry" | "event" }>;
type SavedCommand = { payloadHash: string; response: Extract<ServerFrame, { type: "response" }> };
type SavedChallenge = { command: CommandFrame };

export interface ScheduledTask {
  readonly atMs: number;
  readonly order: number;
  readonly run: () => void;
}
export class VirtualScheduler {
  private nowValue = 0;
  private orderValue = 0;
  private tasks: ScheduledTask[] = [];
  get now(): number {
    return this.nowValue;
  }
  schedule(delayMs: number, run: () => void): void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0)
      throw new RangeError("delayMs must be a non-negative integer");
    this.tasks.push({ atMs: this.nowValue + delayMs, order: this.orderValue++, run });
    this.tasks.sort((a, b) => a.atMs - b.atMs || a.order - b.order);
  }
  advanceBy(deltaMs: number): void {
    this.advanceTo(this.nowValue + deltaMs);
  }
  advanceTo(targetMs: number): void {
    if (!Number.isSafeInteger(targetMs) || targetMs < this.nowValue)
      throw new RangeError("virtual time cannot move backwards");
    while (this.tasks.length > 0 && this.tasks[0]!.atMs <= targetMs) {
      const task = this.tasks.shift()!;
      this.nowValue = task.atMs;
      task.run();
    }
    this.nowValue = targetMs;
  }
  pending(): number {
    return this.tasks.length;
  }
  clear(): void {
    this.tasks = [];
  }
}

interface ClientState {
  id: string;
  queue: ServerFrame[];
  closed: boolean;
  attached: boolean;
  hello: boolean;
  cursor: Cursor;
  commands: Map<string, SavedCommand>;
  challenges: Map<string, SavedChallenge>;
}
export interface FixtureClient {
  readonly id: string;
  readonly closed: boolean;
  readonly queued: number;
  readonly attached: boolean;
}

function branded<T extends string>(value: string): T {
  return value as T;
}
function sessionCursor(seed: ScenarioSeed, seq: number, epoch: string): Cursor {
  return { epoch, seq };
}
function sessionRef(seed: ScenarioSeed) {
  return {
    hostId: branded<HostId>(seed.hostId),
    sessionId: branded<SessionId>(seed.sessionId),
    project: {
      projectId: branded<ProjectId>(seed.projectId),
      canonicalCwd: `/workspace/${seed.id}`,
    },
    revision: branded<Revision>(seed.revision),
    title: `${seed.id} fixture`,
    status: "active" as const,
    updatedAt: seed.baseTime,
    liveState: { phase: "idle" },
    model: "fixture-model",
  };
}
export function buildHistory(seed: ScenarioSeed): DurableEntry[] {
  const count = seed.historyMessages ?? 1;
  const entries: DurableEntry[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < count; i++) {
    const id = `entry-${seed.id}-${String(i + 1).padStart(5, "0")}`;
    entries.push({
      id: branded(id),
      parentId: parentId === null ? null : branded<EntryId>(parentId),
      hostId: branded(seed.hostId),
      sessionId: branded(seed.sessionId),
      kind: "message",
      timestamp: new Date(Date.parse(seed.baseTime) + i * 1000).toISOString(),
      data: { role: i % 2 === 0 ? "user" : "assistant", text: `message-${i + 1}` },
    });
    parentId = id;
  }
  return entries;
}
export function buildHistoryParts(seed: ScenarioSeed): readonly Record<string, unknown>[] {
  const count = seed.historyParts ?? (seed.historyMessages ?? 1) * 3;
  return Array.from({ length: count }, (_, i) => ({
    id: `part-${seed.id}-${String(i + 1).padStart(5, "0")}`,
    messageIndex: Math.floor(i / 3),
    ordinal: i % 3,
    text: `part-${i + 1}`,
  }));
}
function buildEntry(
  seed: ScenarioSeed,
  ordinal: number,
  text: string,
  parentId: string | null = null,
  entryId = `entry-${seed.id}-${ordinal}`,
): DurableEntry {
  return {
    id: branded(entryId),
    parentId: parentId === null ? null : branded<EntryId>(parentId),
    hostId: branded(seed.hostId),
    sessionId: branded(seed.sessionId),
    kind: "message",
    timestamp: new Date(Date.parse(seed.baseTime) + ordinal * 1000).toISOString(),
    data: { role: "assistant", text },
  };
}
function snapshotEntries(seed: ScenarioSeed): DurableEntry[] {
  if (seed.historyMessages !== undefined) return buildHistory(seed).slice(-MAX_HISTORY_SNAPSHOT);
  const prompt = seed.scripts.prompt.filter((step) => step.kind === "entry");
  if (prompt.length === 0) return [buildEntry(seed, 1, "fixture ready")];
  return prompt.map((step, i) =>
    buildEntry(
      seed,
      i + 1,
      step.text ?? `entry-${i + 1}`,
      i === 0 ? null : `entry-${seed.id}-${i}`,
    ),
  );
}

export class FixtureEngine {
  readonly scheduler: VirtualScheduler;
  readonly seed: ScenarioSeed;
  private clients = new Map<string, ClientState>();
  private nextClient = 1;
  private seq = 0;
  private durableCount = 0;
  private epoch: string;
  private revision: Revision;
  private journal: JournalFrame[] = [];
  private durableEntries: DurableEntry[];
  private closed = false;
  private nextLiveEntry = 1;
  constructor(seed: ScenarioSeed, scheduler = new VirtualScheduler()) {
    this.seed = seed;
    this.scheduler = scheduler;
    this.epoch = seed.epoch;
    this.revision = branded<Revision>(seed.revision);
    this.durableEntries = snapshotEntries(seed);
  }
  get virtualTime(): number {
    return this.scheduler.now;
  }
  get currentCursor(): Cursor {
    return sessionCursor(this.seed, this.seq, this.epoch);
  }
  get currentRevision(): Revision {
    return this.revision;
  }
  get journalSize(): number {
    return this.journal.length;
  }
  get clientCount(): number {
    return this.clients.size;
  }
  get stateHash(): string {
    return canonicalSha256({
      seed: this.seed,
      epoch: this.epoch,
      seq: this.seq,
      revision: this.revision,
      journal: this.journal.map((frame) => frame.cursor),
      durableEntries: this.durableEntries.map((entry) => entry.id),
      clients: [...this.clients].map(([id, state]) => ({
        id,
        closed: state.closed,
        hello: state.hello,
        attached: state.attached,
        cursor: state.cursor,
      })),
    });
  }
  connect(id = `client-${this.nextClient++}`): FixtureClient {
    if (this.closed) throw new Error("fixture engine is closed");
    if (this.clients.has(id)) throw new Error(`client already exists: ${id}`);
    this.clients.set(id, {
      id,
      queue: [],
      closed: false,
      attached: false,
      hello: false,
      cursor: sessionCursor(this.seed, 0, this.epoch),
      commands: new Map(),
      challenges: new Map(),
    });
    return this.clientInfo(id);
  }
  clientInfo(id: string): FixtureClient {
    const state = this.requireClient(id);
    return { id, closed: state.closed, queued: state.queue.length, attached: state.attached };
  }
  receive(id: string, input: unknown): readonly ServerFrame[] {
    const state = this.requireClient(id);
    if (state.closed) return [];
    let frame: ClientFrame;
    try {
      frame = decodeClientFrame(input);
    } catch (error) {
      this.emit(state, this.errorFrom(error));
      return this.drain(id);
    }
    if (frame.type === "hello") {
      if (state.hello)
        this.emit(state, {
          v: V,
          type: "error",
          code: "INVALID_FRAME",
          message: "hello may only be sent once",
        });
      else this.onHello(state, frame);
      return this.drain(id);
    }
    if (!state.hello) {
      this.emit(state, {
        v: V,
        type: "error",
        code: "HELLO_REQUIRED",
        message: "hello is required before other frames",
      });
      return this.drain(id);
    }
    switch (frame.type) {
      case "ping":
        this.emit(state, { v: V, type: "pong", nonce: frame.nonce, timestamp: frame.timestamp });
        break;
      case "command":
        this.onCommand(state, frame);
        break;
      case "pair.start":
        this.emit(state, {
          v: V,
          type: "pair.ok",
          requestId: frame.requestId,
          pairingId: "pairing-fixture",
          deviceId: frame.deviceId,
          deviceName: frame.deviceName,
          platform: frame.platform,
          requestedCapabilities: frame.requestedCapabilities,
          grantedCapabilities: frame.requestedCapabilities,
          deviceToken: "fixture-device-token",
          expiresAt: new Date(Date.parse(this.seed.baseTime) + 3_600_000).toISOString(),
        } as unknown as ServerFrame);
        break;
      case "confirm":
        this.onConfirm(state, frame);
        break;
      case "terminal.input":
        this.emitTerminalOutput(state, frame);
        break;
      case "terminal.resize":
        break;
      case "terminal.close":
        this.emitTerminalExit(state, frame);
        break;
      default:
        this.emit(state, {
          v: V,
          type: "error",
          code: "INVALID_FRAME",
          message: "unsupported fixture client frame",
        });
    }
    return this.drain(id);
  }
  restart(epoch: string): void {
    if (epoch.length === 0 || epoch === this.epoch) throw new Error("restart requires a new epoch");
    this.epoch = epoch;
    this.seq = 0;
    this.durableCount = 0;
    this.revision = branded<Revision>(this.seed.revision);
    this.journal = [];
    for (const state of this.clients.values()) {
      state.queue = [];
      state.attached = false;
      state.cursor = sessionCursor(this.seed, 0, this.epoch);
      state.commands.clear();
      state.challenges.clear();
    }
  }
  attach(id: string, saved?: Cursor): readonly ServerFrame[] {
    const state = this.requireClient(id);
    if (!state.hello || state.closed) return [];
    this.attachState(state, saved);
    return this.drain(id);
  }
  executeFaults(): readonly { id: string; code: string; message: string }[] {
    return this.seed.faults.map((fault) => {
      try {
        decodeClientFrame(fault.frame);
        return { id: fault.id, code: "UNEXPECTED_SUCCESS", message: "fault unexpectedly decoded" };
      } catch (error) {
        const protocolCode = error instanceof AppWireError ? error.code : "INVALID_FRAME";
        return {
          id: fault.id,
          code: protocolCode,
          message: error instanceof Error ? error.message : "invalid frame",
        };
      }
    });
  }
  advanceBy(ms: number): void {
    this.scheduler.advanceBy(ms);
  }
  advanceTo(ms: number): void {
    this.scheduler.advanceTo(ms);
  }
  drain(id: string): readonly ServerFrame[] {
    const state = this.requireClient(id);
    return state.queue.splice(0);
  }
  closeClient(
    id: string,
    code = "fixture_shutdown",
    reason = "fixture closed",
  ): readonly ServerFrame[] {
    const state = this.requireClient(id);
    if (!state.closed) {
      state.queue = [];
      this.emit(state, { v: V, type: "bye", code, reason, retryable: false });
      state.closed = true;
      state.attached = false;
    }
    return this.drain(id);
  }
  disconnect(id: string): void {
    this.clients.delete(id);
  }
  close(): void {
    if (this.closed) return;
    for (const id of this.clients.keys()) this.closeClient(id);
    this.scheduler.clear();
    this.clients.clear();
    this.closed = true;
  }
  inspect(clientId: string): FixtureClient {
    return this.clientInfo(clientId);
  }
  private requireClient(id: string): ClientState {
    const state = this.clients.get(id);
    if (!state) throw new Error(`unknown fixture client: ${id}`);
    return state;
  }
  private emit(state: ClientState, frame: ServerFrame): void {
    decodeServerFrame(frame);
    if (state.closed) return;
    if (state.queue.length >= MAX_QUEUE) {
      state.closed = true;
      state.attached = false;
      state.queue = [
        { v: V, type: "bye", code: "backpressure", reason: "fixture queue limit", retryable: true },
      ];
      return;
    }
    state.queue.push(frame);
  }
  private broadcast(frame: JournalFrame): void {
    for (const state of this.clients.values())
      if (state.hello && state.attached && !state.closed) this.emit(state, frame);
  }
  private errorFrom(error: unknown): ServerFrame {
    const code = error instanceof AppWireError ? error.code : "INVALID_FRAME";
    const message = error instanceof Error ? error.message : "invalid frame";
    return { v: V, type: "error", code, message };
  }
  private onHello(state: ClientState, frame: Extract<ClientFrame, { type: "hello" }>): void {
    state.hello = true;
    const saved = frame.savedCursors.find(
      (value) => value.hostId === this.seed.hostId && value.sessionId === this.seed.sessionId,
    );
    const resumed =
      saved !== undefined && saved.cursor.epoch === this.epoch && saved.cursor.seq === this.seq;
    this.emit(state, {
      v: V,
      type: "welcome",
      selectedProtocol: V,
      hostId: branded<HostId>(this.seed.hostId),
      ompVersion: "fixture",
      ompBuild: "deterministic",
      appserverVersion: "fixture",
      appserverBuild: "deterministic",
      epoch: this.epoch,
      grantedCapabilities: [
        "catalog.read",
        "sessions.read",
        "sessions.prompt",
        "sessions.control",
        "sessions.manage",
      ],
      grantedFeatures: ["catalog.metadata", "resume"],
      negotiatedLimits: { maxInputBytes: 1_048_576 },
      authentication: "local",
      resumed,
    });
    this.emit(state, {
      v: V,
      type: "sessions",
      cursor: sessionCursor(this.seed, this.seq, this.epoch),
      sessions: [sessionRef(this.seed)],
    });
    if (saved === undefined) this.emitSnapshot(state);
    else state.cursor = { epoch: saved.cursor.epoch, seq: saved.cursor.seq };
  }
  private emitSnapshot(state: ClientState): void {
    this.emit(state, {
      v: V,
      type: "snapshot",
      cursor: sessionCursor(this.seed, this.seq, this.epoch),
      revision: this.revision,
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      entries: this.durableEntries.slice(-MAX_HISTORY_SNAPSHOT),
    });
    state.cursor = this.currentCursor;
  }
  private emitGap(state: ClientState, reason: string): void {
    this.emit(state, {
      v: V,
      type: "gap",
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      from: sessionCursor(this.seed, 0, this.epoch),
      to: this.currentCursor,
      reason,
    });
  }
  private attachState(state: ClientState, saved?: Cursor): void {
    state.attached = true;
    if (saved === undefined) {
      this.emitSnapshot(state);
      return;
    }
    if (saved.epoch !== this.epoch) {
      this.emitGap(state, "epoch_changed");
      this.emitSnapshot(state);
      return;
    }
    const oldest = this.journal[0]?.cursor.seq ?? this.seq + 1;
    if (saved.seq > this.seq || saved.seq < oldest - 1) {
      this.emitGap(state, "journal_gap");
      this.emitSnapshot(state);
      return;
    }
    for (const frame of this.journal) if (frame.cursor.seq > saved.seq) this.emit(state, frame);
    state.cursor = this.currentCursor;
  }
  private onCommand(state: ClientState, frame: CommandFrame): void {
    const descriptor = COMMAND_DESCRIPTORS[frame.command];
    if (!descriptor) {
      this.emit(state, {
        v: V,
        type: "error",
        code: "INVALID_FRAME",
        message: "unsupported command",
      });
      return;
    }
    const base = {
      v: V,
      type: "response" as const,
      requestId: frame.requestId,
      commandId: frame.commandId,
      command: frame.command,
      hostId: branded<HostId>(this.seed.hostId),
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
    };
    if (
      frame.hostId !== this.seed.hostId ||
      (descriptor.scope === "session" && frame.sessionId !== this.seed.sessionId)
    ) {
      this.emit(state, {
        ...base,
        ok: false,
        error: { code: "not_found", message: "fixture host or session not found" },
      });
      return;
    }
    const key = String(frame.commandId);
    const payloadHash = canonicalSha256({
      command: frame.command,
      hostId: frame.hostId,
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      ...(frame.expectedRevision === undefined ? {} : { expectedRevision: frame.expectedRevision }),
      ...(frame.confirmationId === undefined ? {} : { confirmationId: frame.confirmationId }),
      args: frame.args,
    });
    if (descriptor.confirmation === "challenge") {
      if (frame.confirmationId !== undefined) {
        this.emit(state, {
          ...base,
          ok: false,
          error: {
            code: "confirmation_invalid",
            message: "command confirmation must be approved through a confirm frame",
          },
        });
        return;
      }
      const confirmationId = branded<ConfirmationId>(`confirmation-${String(frame.commandId)}`);
      state.challenges.set(String(confirmationId), { command: frame });
      this.emit(state, {
        v: V,
        type: "confirmation",
        confirmationId,
        commandId: frame.commandId,
        hostId: branded<HostId>(this.seed.hostId),
        ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
        commandHash: payloadHash,
        revision: this.revision,
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: frame.command,
      });
      return;
    }
    const saved = state.commands.get(key);
    if (saved !== undefined) {
      if (saved.payloadHash === payloadHash) this.emit(state, saved.response);
      else
        this.emit(state, {
          ...base,
          ok: false,
          error: {
            code: "idempotency_conflict",
            message: "commandId was already used with a different payload",
            details: { commandId: key, payloadHash },
          },
        });
      return;
    }
    const response = this.makeCommandResponse(frame, base);
    state.commands.set(key, { payloadHash, response });
    this.emit(state, response);
    this.emitCommandSideFrames(state, frame);
    if (frame.command === "session.attach") {
      const args = frame.args;
      const savedCursor = "cursor" in args ? this.decodeCursor(args.cursor) : undefined;
      this.attachState(state, savedCursor);
    }
  }
  private onConfirm(state: ClientState, frame: Extract<ClientFrame, { type: "confirm" }>): void {
    const saved = state.challenges.get(String(frame.confirmationId));
    const valid =
      saved !== undefined &&
      saved.command.commandId === frame.commandId &&
      saved.command.hostId === frame.hostId &&
      saved.command.sessionId === frame.sessionId;
    if (!valid || saved === undefined) {
      this.emit(state, {
        v: V,
        type: "response",
        requestId: frame.requestId,
        commandId: frame.commandId,
        hostId: branded<HostId>(this.seed.hostId),
        ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
        ok: false,
        error: { code: "confirmation_invalid", message: "confirmation is invalid or expired" },
      });
      return;
    }

    state.challenges.delete(String(frame.confirmationId));
    const command = saved.command;
    const base = {
      v: V,
      type: "response" as const,
      requestId: command.requestId,
      commandId: command.commandId,
      command: command.command,
      hostId: branded<HostId>(this.seed.hostId),
      ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
    };
    const response =
      frame.decision === "deny"
        ? {
            ...base,
            ok: false as const,
            error: { code: "confirmation_denied", message: "command was denied" },
          }
        : this.makeCommandResponse(command, base);
    const payloadHash = canonicalSha256({
      command: command.command,
      hostId: command.hostId,
      ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
      ...(command.expectedRevision === undefined
        ? {}
        : { expectedRevision: command.expectedRevision }),
      confirmationId: frame.confirmationId,
      args: command.args,
    });
    state.commands.set(String(command.commandId), { payloadHash, response });
    this.emit(state, response);
    if (frame.decision === "approve") this.emitCommandSideFrames(state, command);
  }
  private emitTerminalOutput(
    state: ClientState,
    frame: Extract<ClientFrame, { type: "terminal.input" }>,
  ): void {
    this.emit(state, {
      v: V,
      type: "terminal.output",
      hostId: frame.hostId,
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cursor: this.currentCursor,
      stream: "stdout",
      data: frame.data,
      ...(frame.encoding === undefined ? {} : { encoding: frame.encoding }),
    } as unknown as ServerFrame);
  }
  private emitTerminalExit(
    state: ClientState,
    frame: Extract<ClientFrame, { type: "terminal.close" }>,
  ): void {
    this.emit(state, {
      v: V,
      type: "terminal.exit",
      hostId: frame.hostId,
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cursor: this.currentCursor,
      exitCode: 0,
    } as unknown as ServerFrame);
  }
  private emitCommandSideFrames(state: ClientState, frame: CommandFrame): void {
    const ids = {
      v: V,
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      cursor: this.currentCursor,
      revision: this.revision,
    };
    let additive: unknown;
    if (frame.command === "host.watch")
      additive = { ...ids, type: "host.watch", watchId: "watch-fixture", state: "started" };
    else if (frame.command === "controller.lease.acquire" || frame.command === "controller.lease.renew" || frame.command === "controller.lease.release")
      additive = { ...ids, type: "lease", leaseId: "lease-fixture", kind: "controller", state: frame.command.endsWith("release") ? "released" : frame.command.endsWith("renew") ? "renewed" : "acquired", owner: "fixture-device", expiresAt: new Date(Date.parse(this.seed.baseTime) + 60_000).toISOString() };
    else if (frame.command === "prompt.lease.acquire" || frame.command === "prompt.lease.renew" || frame.command === "prompt.lease.release")
      additive = { ...ids, type: "prompt.lease", leaseId: "lease-fixture", kind: "prompt", state: frame.command.endsWith("release") ? "released" : frame.command.endsWith("renew") ? "renewed" : "acquired", owner: "fixture-device", expiresAt: new Date(Date.parse(this.seed.baseTime) + 60_000).toISOString() };
    else if (frame.command === "session.watch")
      additive = [
        { ...ids, type: "session.watch", watchId: "watch-fixture", state: "started" },
        { ...ids, type: "session.state", state: "ready" },
        { ...ids, type: "session.delta", upsert: sessionRef(this.seed) },
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
        { v: V, type: "audit.event", hostId: ids.hostId, cursor: ids.cursor, event: { eventId: "operation-fixture", hostId: ids.hostId, action: "fixture.read", actor: "fixture", timestamp: this.seed.baseTime } },
      ];
    else if (frame.command === "settings.read")
      additive = { v: V, type: "settings", hostId: ids.hostId, revision: ids.revision, settings: {} };
    else if (frame.command === "preview.launch")
      additive = { ...ids, type: "preview.launch", previewId: "preview-fixture", url: "http://127.0.0.1/fixture", revision: ids.revision };
    else if (frame.command === "preview.state")
      additive = { ...ids, type: "preview.state", previewId: "preview-fixture", state: "ready" };
    else if (frame.command === "preview.navigate")
      additive = { ...ids, type: "preview.navigation", previewId: "preview-fixture", url: "http://127.0.0.1/fixture" };
    else if (frame.command === "preview.capture")
      additive = { ...ids, type: "preview.capture", previewId: "preview-fixture", content: "", encoding: "base64", mimeType: "text/plain" };
    if (Array.isArray(additive)) for (const frame of additive) this.emit(state, frame as ServerFrame);
    else if (additive !== undefined) this.emit(state, additive as ServerFrame);
  }
  private makeCommandResponse(
    frame: CommandFrame,
    base: Omit<Extract<ServerFrame, { type: "response" }>, "ok" | "result" | "error">,
  ): Extract<ServerFrame, { type: "response" }> {
    if (
      frame.expectedRevision !== undefined &&
      frame.expectedRevision !== this.revision &&
      frame.command === "session.prompt"
    )
      return {
        ...base,
        ok: false,
        error: {
          code: "stale_revision",
          message: "expected revision does not match fixture revision",
          details: { expectedRevision: frame.expectedRevision, actualRevision: this.revision },
        },
      };
    if (frame.command === "session.attach")
      return { ...base, ok: true, result: { attached: true, cursor: this.currentCursor } };
    if (frame.command === "session.prompt") {
      this.schedulePrompt();
      return { ...base, ok: true, result: { accepted: true } };
    }
    if (frame.command === "session.create")
      return { ...base, ok: true, result: { session: sessionRef(this.seed) } };
    if (frame.command === "session.list" || frame.command === "host.list")
      return { ...base, ok: true, result: { cursor: this.currentCursor, sessions: [sessionRef(this.seed)] } };
    if (frame.command === "session.cancel" || frame.command === "agent.cancel")
      return { ...base, ok: true, result: { cancelled: true } };
    if (frame.command === "session.close") return { ...base, ok: true, result: { closed: true } };
    if (frame.command === "files.read") return { ...base, ok: true, result: { content: "" } };
    if (frame.command === "files.write" || frame.command === "files.patch" || frame.command.startsWith("review."))
      return { ...base, ok: true, result: {} };
    if (frame.command === "files.list") return { ...base, ok: true, result: { entries: [] } };
    if (frame.command === "files.diff") return { ...base, ok: true, result: { diff: "" } };
    if (frame.command === "term.open") return { ...base, ok: true, result: { terminalId: "terminal-fixture" } };
    if (frame.command === "audit.read" || frame.command === "audit.tail")
      return { ...base, ok: true, result: { events: [] } };
    if (frame.command === "catalog.get")
      return {
        ...base,
        ok: true,
        result: {
          revision: this.revision,
          items: [
            {
              id: "cmd-session-cancel",
              kind: "command",
              name: "session.cancel",
              description: "Stop the running session turn",
              capabilities: ["sessions.control"],
              supported: true,
            },
          ],
        },
      };
    if (frame.command === "settings.read")
      return {
        ...base,
        ok: true,
        result: { revision: this.revision, settings: {} },
      };
    if (frame.command.startsWith("host.watch") || frame.command.startsWith("session.watch"))
      return { ...base, ok: true, result: { watchId: "watch-fixture", cursor: this.currentCursor } };
    if (frame.command.includes(".lease."))
      return { ...base, ok: true, result: { leaseId: "lease-fixture", cursor: this.currentCursor } };
    if (frame.command === "preview.capture")
      return { ...base, ok: true, result: { content: "" } };
    return { ...base, ok: true, result: { accepted: true } };
  }
  private decodeCursor(value: unknown): Cursor | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const cursor = value as { epoch?: unknown; seq?: unknown };
    if (
      typeof cursor.epoch !== "string" ||
      !Number.isSafeInteger(cursor.seq) ||
      (cursor.seq as number) < 0
    )
      return undefined;
    return { epoch: cursor.epoch, seq: cursor.seq as number };
  }
  private schedulePrompt(): void {
    let parent: string | null = null;
    let liveEntryId: string | null = null;
    let accumulatedText = "";
    const publishEvent = (event: Record<string, unknown>) => {
      const nextSeq = this.seq + 1;
      const frame: LiveEventFrame = {
        v: V,
        type: "event",
        cursor: sessionCursor(this.seed, nextSeq, this.epoch),
        hostId: branded<HostId>(this.seed.hostId),
        sessionId: branded<SessionId>(this.seed.sessionId),
        event: {
          ...event,
          at: new Date(Date.parse(this.seed.baseTime) + this.scheduler.now).toISOString(),
        } as unknown as LiveEventFrame["event"],
      };
      this.publish(frame);
    };

    // Mirror the observable production lifecycle. Scheduling at zero keeps the
    // command response first while allowing tests to hold the turn active.
    this.scheduler.schedule(0, () => {
      if (this.closed) return;
      publishEvent({ type: "agent.start" });
      publishEvent({ type: "turn.start" });
    });

    for (const step of this.seed.scripts.prompt) {
      this.scheduler.schedule(step.atMs, () => {
        if (this.closed) return;
        if (step.kind === "event") {
          liveEntryId ??= `entry-${this.seed.id}-live-${this.nextLiveEntry++}`;
          accumulatedText += step.text ?? "";
          publishEvent({
            type: "message.update",
            entryId: liveEntryId,
            role: "assistant",
            text: accumulatedText,
          });
        } else {
          this.durableCount += 1;
          const suffix = `-${this.durableCount}`;
          this.revision = branded<Revision>(
            `${this.seed.revision.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`,
          );
          const durableEntryId = `entry-${this.seed.id}-durable-${this.durableCount}`;
          const entry = buildEntry(
            this.seed,
            this.seq + 1,
            step.text ?? `entry-${this.seq + 1}`,
            parent,
            durableEntryId,
          );
          if (liveEntryId !== null) {
            publishEvent({
              type: "message.settled",
              transientEntryId: liveEntryId,
              entryId: durableEntryId,
            });
          }
          parent = entry.id;
          liveEntryId = null;
          accumulatedText = "";
          const nextSeq = this.seq + 1;
          this.publish({
            v: V,
            type: "entry",
            cursor: sessionCursor(this.seed, nextSeq, this.epoch),
            revision: this.revision,
            hostId: branded<HostId>(this.seed.hostId),
            sessionId: branded<SessionId>(this.seed.sessionId),
            entry,
          });
        }
      });
    }

    const finalAtMs = this.seed.scripts.prompt.reduce(
      (latest, step) => Math.max(latest, step.atMs),
      0,
    );
    this.scheduler.schedule(finalAtMs, () => {
      if (this.closed) return;
      publishEvent({ type: "turn.end" });
      publishEvent({ type: "agent.end", status: "completed", messageCount: 1 });
    });
  }
  private publish(frame: JournalFrame): void {
    this.seq = frame.cursor.seq;
    if (frame.type === "entry") {
      const existing = this.durableEntries.findIndex((entry) => entry.id === frame.entry.id);
      if (existing === -1) this.durableEntries.push(frame.entry);
      else this.durableEntries[existing] = frame.entry;
    }
    this.journal.push(frame);
    if (this.journal.length > MAX_JOURNAL)
      this.journal.splice(0, this.journal.length - MAX_JOURNAL);
    this.broadcast(frame);
  }
}
