import {
  type CommandFrame,
  type DurableEntry,
  type EntryId,
  type HostId,
  type LiveEventFrame,
  type ProjectId,
  type Revision,
  type ServerFrame,
  type SessionId,
  type SessionRef,
} from "@t4-code/protocol";
import type { ScenarioSeed } from "./seeds.ts";
import type { VirtualScheduler } from "./virtual-scheduler.ts";

const V = "omp-app/1" as const;
const MAX_HISTORY_SNAPSHOT = 900;

export type Cursor = { epoch: string; seq: number };
export type JournalFrame = Extract<ServerFrame, { type: "entry" | "event" }>;

export interface CreatedFixtureSession {
  readonly ordinal: number;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  revision: Revision;
  title: string;
  model: string;
  updatedAt: string;
  archivedAt?: string;
  deleted: boolean;
  seq: number;
  durableCount: number;
  nextLiveEntry: number;
  managementRevision: number;
  controlRevision: number;
  journal: JournalFrame[];
  durableEntries: DurableEntry[];
}

export interface FixturePromptTarget {
  readonly seed: ScenarioSeed;
  readonly scheduler: VirtualScheduler;
  readonly hostId: HostId;
  readonly sessionId: SessionId;
  readonly epoch: string;
  isUnavailable(): boolean;
  currentSeq(): number;
  nextLiveEntryId(): string;
  commitDurable(
    text: string | undefined,
    parentId: string | null,
  ): {
    entry: DurableEntry;
    revision: Revision;
  };
  publish(frame: JournalFrame): void;
  onDurablePublished?(): void;
}

export function branded<T extends string>(value: string): T {
  return value as T;
}

export function sessionCursor(_seed: ScenarioSeed, seq: number, epoch: string): Cursor {
  return { epoch, seq };
}

export function sessionRef(
  seed: ScenarioSeed,
  options: {
    archivedAt?: string;
    model?: string;
    projectId?: ProjectId;
    revision?: Revision;
    sessionId?: SessionId;
    title?: string;
    updatedAt?: string;
  } = {},
): SessionRef {
  return {
    hostId: branded<HostId>(seed.hostId),
    sessionId: options.sessionId ?? branded<SessionId>(seed.sessionId),
    project: {
      projectId: options.projectId ?? branded<ProjectId>(seed.projectId),
    },
    revision: options.revision ?? branded<Revision>(seed.revision),
    title: options.title ?? `${seed.id} fixture`,
    status: "idle",
    updatedAt: options.updatedAt ?? seed.baseTime,
    liveState: { phase: "idle" },
    model: options.model ?? "fixture-model",
    ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
  };
}

export function derivedRevision(seed: ScenarioSeed, suffix: string): Revision {
  const boundedSuffix = `-${suffix}`.slice(-127);
  return branded<Revision>(
    `${seed.revision.slice(0, Math.max(1, 128 - boundedSuffix.length))}${boundedSuffix}`,
  );
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

export function buildEntry(
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

export function snapshotEntries(seed: ScenarioSeed): DurableEntry[] {
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

export function decodeCursor(value: unknown): Cursor | undefined {
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

export function createCreatedFixtureSession(
  seed: ScenarioSeed,
  frame: CommandFrame,
  ordinal: number,
  now: number,
): CreatedFixtureSession {
  const sessionId = branded<SessionId>(
    `${seed.sessionId}-created-${String(ordinal).padStart(4, "0")}`,
  );
  return {
    ordinal,
    sessionId,
    projectId: branded<ProjectId>(String(frame.args.projectId)),
    revision: derivedRevision(seed, `created-${ordinal}`),
    title: typeof frame.args.title === "string" ? frame.args.title : `New session ${ordinal}`,
    model: "fixture-model",
    updatedAt: new Date(Date.parse(seed.baseTime) + now + ordinal).toISOString(),
    deleted: false,
    seq: 0,
    durableCount: 0,
    nextLiveEntry: 1,
    managementRevision: 0,
    controlRevision: 0,
    journal: [],
    durableEntries: [],
  };
}

export function applyCreatedSessionManagementMutation(
  seed: ScenarioSeed,
  session: CreatedFixtureSession,
  frame: CommandFrame,
  now: number,
): void {
  session.managementRevision += 1;
  session.revision = derivedRevision(
    seed,
    `created-${session.ordinal}-management-${session.managementRevision}`,
  );
  session.updatedAt = new Date(Date.parse(seed.baseTime) + now + session.ordinal).toISOString();
  if (frame.command === "session.rename") {
    session.title = String(frame.args.name);
    return;
  }
  if (frame.command === "session.archive") {
    session.archivedAt = new Date(Date.parse(seed.baseTime) + now).toISOString();
    return;
  }
  if (frame.command === "session.restore") {
    delete session.archivedAt;
    return;
  }
  if (frame.command === "session.delete") session.deleted = true;
}

export function applyCreatedSessionModelMutation(
  seed: ScenarioSeed,
  session: CreatedFixtureSession,
  frame: CommandFrame,
  now: number,
): void {
  session.controlRevision += 1;
  session.revision = derivedRevision(
    seed,
    `created-${session.ordinal}-control-${session.controlRevision}`,
  );
  session.updatedAt = new Date(Date.parse(seed.baseTime) + now + session.ordinal).toISOString();
  if (typeof frame.args.selector === "string") {
    session.model = frame.args.selector;
    return;
  }
  const role = String(frame.args.role);
  const index = role === "default" ? 1 : Number.parseInt(role.replace(/^cycle-/u, ""), 10);
  if (Number.isInteger(index) && index >= 1 && index <= 12) {
    session.model = `fixture/model-${String(index).padStart(3, "0")}`;
  }
}

export function scheduleFixturePrompt(target: FixturePromptTarget): void {
  let parent: string | null = null;
  let liveEntryId: string | null = null;
  let accumulatedText = "";
  const publishEvent = (event: Record<string, unknown>) => {
    const frame: LiveEventFrame = {
      v: V,
      type: "event",
      cursor: sessionCursor(target.seed, target.currentSeq() + 1, target.epoch),
      hostId: target.hostId,
      sessionId: target.sessionId,
      event: {
        ...event,
        at: new Date(Date.parse(target.seed.baseTime) + target.scheduler.now).toISOString(),
      } as unknown as LiveEventFrame["event"],
    };
    target.publish(frame);
  };

  target.scheduler.schedule(0, () => {
    if (target.isUnavailable()) return;
    publishEvent({ type: "agent.start" });
    publishEvent({ type: "turn.start" });
  });

  for (const step of target.seed.scripts.prompt) {
    target.scheduler.schedule(step.atMs, () => {
      if (target.isUnavailable()) return;
      if (step.kind === "event") {
        liveEntryId ??= target.nextLiveEntryId();
        accumulatedText += step.text ?? "";
        publishEvent({
          type: "message.update",
          entryId: liveEntryId,
          role: "assistant",
          text: accumulatedText,
        });
        return;
      }

      const { entry, revision } = target.commitDurable(step.text, parent);
      if (liveEntryId !== null) {
        publishEvent({
          type: "message.settled",
          transientEntryId: liveEntryId,
          entryId: entry.id,
        });
      }
      parent = entry.id;
      liveEntryId = null;
      accumulatedText = "";
      target.publish({
        v: V,
        type: "entry",
        cursor: sessionCursor(target.seed, target.currentSeq() + 1, target.epoch),
        revision,
        hostId: target.hostId,
        sessionId: target.sessionId,
        entry,
      });
      target.onDurablePublished?.();
    });
  }

  const finalAtMs = target.seed.scripts.prompt.reduce(
    (latest, step) => Math.max(latest, step.atMs),
    0,
  );
  target.scheduler.schedule(finalAtMs, () => {
    if (target.isUnavailable()) return;
    publishEvent({ type: "turn.end" });
    publishEvent({ type: "agent.end", status: "completed", messageCount: 1 });
  });
}
