import {
  decodeTranscriptContextArguments,
  decodeTranscriptContextResult,
  decodeTranscriptSearchArguments,
  decodeTranscriptSearchResult,
  hostId,
  sessionId,
  TRANSCRIPT_SEARCH_MAX_RESULTS,
  type HostId,
  type SessionId,
  type TranscriptContextArguments,
  type TranscriptContextResult,
  type TranscriptSearchArguments,
  type TranscriptSearchIndexState,
  type TranscriptSearchItem,
  type TranscriptSearchResult,
} from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import type { DesktopRuntimeController } from "./desktop-runtime.ts";
import { freezeClone, mapValue, type DesktopRuntimeSnapshot } from "./desktop-runtime-contracts.ts";
import type { Unsubscribe } from "./omp-client-contracts.ts";

export { decodeTranscriptContextResult, decodeTranscriptSearchResult } from "@t4-code/protocol";
export type {
  TranscriptContextArguments,
  TranscriptContextResult,
  TranscriptContextRow,
  TranscriptSearchArchivedFilter,
  TranscriptSearchArguments,
  TranscriptSearchHighlight,
  TranscriptSearchIndexState,
  TranscriptSearchIndexStatus,
  TranscriptSearchItem,
  TranscriptSearchResult,
  TranscriptSearchRole,
} from "@t4-code/protocol";

const FEATURE = "transcript.search";
const CAPABILITY = "sessions.read";
/** Client-wide in-memory/display bound across all hosts and pages. */
export const MAX_RETAINED_TRANSCRIPT_SEARCH_ITEMS = 200;
export type TranscriptSearchHostState =
  | TranscriptSearchIndexState
  | "unsupported"
  | "offline"
  | "error";

export interface HostedTranscriptSearchItem extends TranscriptSearchItem {
  readonly hostId: HostId;
}

export interface TranscriptSearchHostStatus {
  readonly hostId: HostId;
  readonly state: TranscriptSearchHostState;
  readonly targetId?: string;
  readonly indexedSessions?: number;
  readonly knownSessions?: number;
  readonly generation?: string;
  readonly incomplete?: boolean;
  readonly nextCursor?: string;
  readonly errorCode?: string;
}

export interface TranscriptSearchSnapshot {
  readonly generation: number;
  readonly searching: boolean;
  readonly items: readonly HostedTranscriptSearchItem[];
  readonly hosts: ReadonlyMap<string, TranscriptSearchHostStatus>;
  readonly incomplete: boolean;
}

export interface TranscriptSearchOptions {
  readonly signal?: AbortSignal;
}

export type TranscriptSearchListener = (snapshot: TranscriptSearchSnapshot) => void;
export type TranscriptSearchRuntime = Pick<DesktopRuntimeController, "command" | "getSnapshot">;

export class TranscriptSearchError extends Error {
  readonly code: "invalid" | "offline" | "unsupported" | "command" | "superseded" | "no_cursor";
  readonly hostId: string | undefined;

  constructor(code: TranscriptSearchError["code"], message: string, hostIdValue?: string) {
    super(message);
    this.name = "TranscriptSearchError";
    this.code = code;
    this.hostId = hostIdValue;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }
}

interface EligibleHost {
  readonly hostId: HostId;
  readonly targetId: string;
}

interface HostPlan {
  readonly eligible: readonly EligibleHost[];
  readonly statuses: Map<string, TranscriptSearchHostStatus>;
}

interface RankedItem {
  readonly item: HostedTranscriptSearchItem;
  readonly rank: number;
}

interface ActiveRun {
  readonly generation: number;
  readonly controller: AbortController;
}

interface SearchMemory {
  readonly generation: number;
  readonly args: TranscriptSearchArguments;
  readonly statuses: Map<string, TranscriptSearchHostStatus>;
  readonly results: Map<string, readonly TranscriptSearchItem[]>;
  readonly cursors: Map<string, Set<string>>;
  visibleLimit: number;
}

function normalizeSearchArguments(args: TranscriptSearchArguments): TranscriptSearchArguments {
  if (args.cursor !== undefined) {
    throw new TranscriptSearchError(
      "invalid",
      "cross-host search cursors must be used through loadMore(hostId)",
    );
  }
  try {
    const query = typeof args.query === "string" ? args.query.trim() : args.query;
    return freezeClone(decodeTranscriptSearchArguments({ ...args, query }));
  } catch {
    throw new TranscriptSearchError("invalid", "transcript search arguments are invalid");
  }
}

function normalizeContextArguments(args: TranscriptContextArguments): TranscriptContextArguments {
  try {
    return freezeClone(decodeTranscriptContextArguments(args));
  } catch {
    throw new TranscriptSearchError("invalid", "transcript context arguments are invalid");
  }
}

function commandFailureCode(result: CommandResult): string {
  const code = result.error?.code;
  return typeof code === "string" && code.length > 0 ? code.slice(0, 128) : "command_failed";
}

function isUnsupportedCode(code: string): boolean {
  return code === "unsupported" || code === "feature_required" || code === "capability_denied";
}

function planHosts(snapshot: DesktopRuntimeSnapshot): HostPlan {
  const hostIds = new Set<string>([...snapshot.targetHosts.values(), ...snapshot.hosts.keys()]);
  const eligible: EligibleHost[] = [];
  const statuses = new Map<string, TranscriptSearchHostStatus>();
  for (const hostIdValue of [...hostIds].sort()) {
    const metadata = snapshot.hosts.get(hostIdValue);
    const connectedTargets = [...snapshot.targetHosts.entries()]
      .filter(
        ([targetId, boundHostId]) =>
          boundHostId === hostIdValue && snapshot.connections.get(targetId) === "connected",
      )
      .map(([targetId]) => targetId)
      .sort();
    if (connectedTargets.length === 0) {
      statuses.set(hostIdValue, Object.freeze({ hostId: hostId(hostIdValue), state: "offline" }));
      continue;
    }
    if (metadata === undefined) {
      statuses.set(hostIdValue, Object.freeze({ hostId: hostId(hostIdValue), state: "error" }));
      continue;
    }
    const firstConnectedTarget = connectedTargets[0];
    if (firstConnectedTarget === undefined) {
      statuses.set(hostIdValue, Object.freeze({ hostId: hostId(hostIdValue), state: "error" }));
      continue;
    }
    const targetId = connectedTargets.includes(metadata.targetId)
      ? metadata.targetId
      : firstConnectedTarget;
    if (
      !metadata.grantedFeatures.includes(FEATURE) ||
      !metadata.grantedCapabilities.includes(CAPABILITY)
    ) {
      statuses.set(
        hostIdValue,
        Object.freeze({ hostId: hostId(hostIdValue), state: "unsupported", targetId }),
      );
      continue;
    }
    const item = Object.freeze({ hostId: hostId(hostIdValue), targetId });
    eligible.push(item);
    statuses.set(hostIdValue, Object.freeze({ hostId: item.hostId, state: "building", targetId }));
  }
  return { eligible: Object.freeze(eligible), statuses };
}

function mergeItems(
  results: ReadonlyMap<string, readonly TranscriptSearchItem[]>,
  limit: number,
): readonly HostedTranscriptSearchItem[] {
  const unique = new Map<string, RankedItem>();
  for (const [hostIdValue, items] of [...results.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const [rank, item] of items.entries()) {
      const key = `${hostIdValue}\u0000${item.sessionId}\u0000${item.anchorId}`;
      if (unique.has(key)) continue;
      unique.set(key, {
        rank,
        item: Object.freeze({ ...item, hostId: hostId(hostIdValue) }),
      });
    }
  }
  return Object.freeze(
    [...unique.values()]
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          right.item.timestamp.localeCompare(left.item.timestamp) ||
          String(left.item.hostId).localeCompare(String(right.item.hostId)) ||
          String(left.item.sessionId).localeCompare(String(right.item.sessionId)) ||
          String(left.item.anchorId).localeCompare(String(right.item.anchorId)),
      )
      .slice(0, limit)
      .map(({ item }) => item),
  );
}

function appendHostItems(
  existing: readonly TranscriptSearchItem[],
  added: readonly TranscriptSearchItem[],
): readonly TranscriptSearchItem[] {
  const items = [...existing];
  const seen = new Set(existing.map((item) => `${item.sessionId}\u0000${item.anchorId}`));
  for (const item of added) {
    const key = `${item.sessionId}\u0000${item.anchorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return Object.freeze(items);
}

function hostedItemKey(item: HostedTranscriptSearchItem): string {
  return `${item.hostId}\u0000${item.sessionId}\u0000${item.anchorId}`;
}

function trimRetainedResults(results: Map<string, readonly TranscriptSearchItem[]>): void {
  const retainedKeys = new Set(
    mergeItems(results, MAX_RETAINED_TRANSCRIPT_SEARCH_ITEMS).map(hostedItemKey),
  );
  for (const [hostIdValue, items] of results) {
    const retained = items.filter((item) =>
      retainedKeys.has(`${hostIdValue}\u0000${item.sessionId}\u0000${item.anchorId}`),
    );
    results.set(hostIdValue, Object.freeze(retained));
  }
}

function rememberNextCursor(
  memory: SearchMemory,
  hostIdValue: string,
  candidate: string | undefined,
): string | undefined {
  if (candidate === undefined) return undefined;
  const seen = memory.cursors.get(hostIdValue) ?? new Set<string>();
  memory.cursors.set(hostIdValue, seen);
  if (seen.has(candidate)) return undefined;
  seen.add(candidate);
  return candidate;
}

function clearPaginationAtDisplayCap(memory: SearchMemory): void {
  if (memory.visibleLimit < MAX_RETAINED_TRANSCRIPT_SEARCH_ITEMS) return;
  for (const [hostIdValue, status] of memory.statuses) {
    if (status.nextCursor === undefined) continue;
    const { nextCursor: _nextCursor, ...withoutCursor } = status;
    memory.statuses.set(hostIdValue, Object.freeze({ ...withoutCursor, incomplete: true }));
  }
}

function freezeSnapshot(
  generation: number,
  searching: boolean,
  statuses: ReadonlyMap<string, TranscriptSearchHostStatus>,
  results: ReadonlyMap<string, readonly TranscriptSearchItem[]>,
  limit: number,
): TranscriptSearchSnapshot {
  const hosts = mapValue(
    [...statuses].map(([key, value]) => [key, Object.freeze({ ...value })] as const),
  );
  const incomplete = [...hosts.values()].some(
    (status) => status.state !== "ready" || status.incomplete === true,
  );
  return Object.freeze({
    generation,
    searching,
    items: mergeItems(results, limit),
    hosts,
    incomplete,
  });
}

function abortError(): TranscriptSearchError {
  return new TranscriptSearchError("superseded", "transcript search was superseded");
}

export class TranscriptSearchCoordinator {
  private readonly runtime: TranscriptSearchRuntime;
  private readonly listeners = new Set<TranscriptSearchListener>();
  private generation = 0;
  private active: ActiveRun | undefined;
  private readonly pagination = new Map<string, ActiveRun>();
  private memory: SearchMemory | undefined;
  private current: TranscriptSearchSnapshot = freezeSnapshot(
    0,
    false,
    new Map(),
    new Map(),
    TRANSCRIPT_SEARCH_MAX_RESULTS,
  );

  constructor(runtime: TranscriptSearchRuntime) {
    this.runtime = runtime;
  }

  getSnapshot(): TranscriptSearchSnapshot {
    return this.current;
  }

  subscribe(listener: TranscriptSearchListener): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  clear(): TranscriptSearchSnapshot {
    this.active?.controller.abort();
    this.active = undefined;
    this.abortPagination();
    this.memory = undefined;
    this.generation += 1;
    this.current = freezeSnapshot(
      this.generation,
      false,
      planHosts(this.runtime.getSnapshot()).statuses,
      new Map(),
      TRANSCRIPT_SEARCH_MAX_RESULTS,
    );
    this.publish();
    return this.current;
  }

  cancel(): void {
    this.active?.controller.abort();
    this.active = undefined;
    this.abortPagination();
    if (this.current.searching) {
      this.current = Object.freeze({ ...this.current, searching: false, incomplete: true });
      this.publish();
    }
  }

  async search(
    args: TranscriptSearchArguments,
    options: TranscriptSearchOptions = {},
  ): Promise<TranscriptSearchSnapshot> {
    const normalized = normalizeSearchArguments(args);
    this.active?.controller.abort();
    this.abortPagination();
    const generation = ++this.generation;
    const controller = new AbortController();
    const active: ActiveRun = { generation, controller };
    this.active = active;
    const removeExternalAbort = this.forwardAbort(options.signal, controller);
    const plan = planHosts(this.runtime.getSnapshot());
    const statuses = new Map(plan.statuses);
    const results = new Map<string, readonly TranscriptSearchItem[]>();
    const limit = normalized.limit ?? 20;
    const memory: SearchMemory = {
      generation,
      args: normalized,
      statuses,
      results,
      cursors: new Map(),
      visibleLimit: limit,
    };
    this.memory = memory;
    this.current = freezeSnapshot(generation, true, statuses, results, limit);
    this.publish();

    const work = Promise.all(
      plan.eligible.map(async (host) => {
        if (controller.signal.aborted || this.active !== active) return;
        let commandResult: CommandResult;
        try {
          commandResult = await this.issueSearch(host, normalized);
        } catch {
          if (controller.signal.aborted || this.active !== active) return;
          statuses.set(
            host.hostId,
            Object.freeze({
              hostId: host.hostId,
              targetId: host.targetId,
              state: "error",
              errorCode: "command_failed",
            }),
          );
          this.current = freezeSnapshot(generation, true, statuses, results, limit);
          this.publish();
          return;
        }
        if (controller.signal.aborted || this.active !== active) return;
        if (commandResult.accepted !== true) {
          const code = commandFailureCode(commandResult);
          statuses.set(
            host.hostId,
            Object.freeze({
              hostId: host.hostId,
              targetId: host.targetId,
              state: isUnsupportedCode(code) ? "unsupported" : "error",
              errorCode: code,
            }),
          );
        } else {
          try {
            const decoded = decodeTranscriptSearchResult(commandResult.result);
            results.set(host.hostId, decoded.items);
            trimRetainedResults(results);
            const nextCursor = rememberNextCursor(memory, host.hostId, decoded.nextCursor);
            statuses.set(
              host.hostId,
              Object.freeze({
                hostId: host.hostId,
                targetId: host.targetId,
                state: decoded.index.state,
                indexedSessions: decoded.index.indexedSessions,
                knownSessions: decoded.index.knownSessions,
                generation: decoded.index.generation,
                incomplete:
                  decoded.incomplete ||
                  (decoded.nextCursor !== undefined && nextCursor === undefined),
                ...(nextCursor === undefined ? {} : { nextCursor }),
              }),
            );
            clearPaginationAtDisplayCap(memory);
          } catch {
            statuses.set(
              host.hostId,
              Object.freeze({
                hostId: host.hostId,
                targetId: host.targetId,
                state: "error",
                errorCode: "invalid_result",
              }),
            );
          }
        }
        if (!controller.signal.aborted && this.active === active) {
          this.current = freezeSnapshot(generation, true, statuses, results, limit);
          this.publish();
        }
      }),
    );

    try {
      await Promise.race([work, this.abortPromise(controller.signal)]);
      if (controller.signal.aborted || this.active !== active) throw abortError();
      this.current = freezeSnapshot(generation, false, statuses, results, limit);
      this.active = undefined;
      this.publish();
      return this.current;
    } catch (error) {
      if (this.active === active) {
        this.active = undefined;
        this.current = Object.freeze({ ...this.current, searching: false, incomplete: true });
        this.publish();
      }
      throw error;
    } finally {
      removeExternalAbort();
    }
  }

  async loadMore(
    hostIdValue: string,
    options: TranscriptSearchOptions = {},
  ): Promise<TranscriptSearchSnapshot> {
    const memory = this.memory;
    if (memory === undefined || memory.generation !== this.generation) {
      throw new TranscriptSearchError("superseded", "transcript search was cleared or superseded");
    }
    if (this.active !== undefined) {
      throw new TranscriptSearchError(
        "invalid",
        "wait for the current transcript search to finish",
      );
    }
    const status = memory.statuses.get(hostIdValue);
    const cursor = status?.nextCursor;
    if (cursor === undefined) {
      throw new TranscriptSearchError(
        "no_cursor",
        "this host has no more transcript results",
        hostIdValue,
      );
    }
    const plan = planHosts(this.runtime.getSnapshot());
    const eligible = plan.eligible.find((candidate) => candidate.hostId === hostIdValue);
    if (eligible === undefined) {
      const currentState = plan.statuses.get(hostIdValue)?.state;
      if (currentState === "offline" || currentState === undefined) {
        throw new TranscriptSearchError("offline", "transcript host is offline", hostIdValue);
      }
      throw new TranscriptSearchError(
        "unsupported",
        "transcript search is unsupported by this host",
        hostIdValue,
      );
    }

    this.pagination.get(hostIdValue)?.controller.abort();
    const controller = new AbortController();
    const run: ActiveRun = { generation: memory.generation, controller };
    this.pagination.set(hostIdValue, run);
    const removeExternalAbort = this.forwardAbort(options.signal, controller);
    this.current = freezeSnapshot(
      memory.generation,
      true,
      memory.statuses,
      memory.results,
      memory.visibleLimit,
    );
    this.publish();

    try {
      if (controller.signal.aborted) throw abortError();
      const command = this.issueSearch(eligible, { ...memory.args, cursor });
      const commandResult = await Promise.race([command, this.abortPromise(controller.signal)]);
      if (
        controller.signal.aborted ||
        this.memory !== memory ||
        this.pagination.get(hostIdValue) !== run ||
        this.generation !== memory.generation
      ) {
        throw abortError();
      }
      if (commandResult.accepted !== true) {
        const code = commandFailureCode(commandResult);
        memory.statuses.set(
          hostIdValue,
          Object.freeze({
            hostId: eligible.hostId,
            targetId: eligible.targetId,
            state: isUnsupportedCode(code) ? "unsupported" : "error",
            errorCode: code,
          }),
        );
        throw new TranscriptSearchError(
          "command",
          "transcript pagination command failed",
          hostIdValue,
        );
      }
      let decoded: TranscriptSearchResult;
      try {
        decoded = decodeTranscriptSearchResult(commandResult.result);
      } catch {
        memory.statuses.set(
          hostIdValue,
          Object.freeze({
            hostId: eligible.hostId,
            targetId: eligible.targetId,
            state: "error",
            errorCode: "invalid_result",
          }),
        );
        throw new TranscriptSearchError(
          "command",
          "transcript pagination result was invalid",
          hostIdValue,
        );
      }
      memory.results.set(
        hostIdValue,
        appendHostItems(memory.results.get(hostIdValue) ?? [], decoded.items),
      );
      trimRetainedResults(memory.results);
      const nextCursor = rememberNextCursor(memory, hostIdValue, decoded.nextCursor);
      memory.statuses.set(
        hostIdValue,
        Object.freeze({
          hostId: eligible.hostId,
          targetId: eligible.targetId,
          state: decoded.index.state,
          indexedSessions: decoded.index.indexedSessions,
          knownSessions: decoded.index.knownSessions,
          generation: decoded.index.generation,
          incomplete:
            decoded.incomplete || (decoded.nextCursor !== undefined && nextCursor === undefined),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        }),
      );
      memory.visibleLimit = Math.min(
        MAX_RETAINED_TRANSCRIPT_SEARCH_ITEMS,
        memory.visibleLimit + (memory.args.limit ?? 20),
      );
      clearPaginationAtDisplayCap(memory);
      this.pagination.delete(hostIdValue);
      this.current = freezeSnapshot(
        memory.generation,
        this.pagination.size > 0,
        memory.statuses,
        memory.results,
        memory.visibleLimit,
      );
      this.publish();
      return this.current;
    } catch (error) {
      if (this.pagination.get(hostIdValue) === run) {
        this.pagination.delete(hostIdValue);
        if (this.memory === memory) {
          const currentStatus = memory.statuses.get(hostIdValue);
          if (
            !(error instanceof TranscriptSearchError && error.code === "superseded") &&
            currentStatus?.state !== "error" &&
            currentStatus?.state !== "unsupported"
          ) {
            memory.statuses.set(
              hostIdValue,
              Object.freeze({
                hostId: eligible.hostId,
                targetId: eligible.targetId,
                state: "error",
                errorCode: "command_failed",
              }),
            );
          }
          this.current = freezeSnapshot(
            memory.generation,
            this.pagination.size > 0,
            memory.statuses,
            memory.results,
            memory.visibleLimit,
          );
          this.publish();
        }
      }
      throw error;
    } finally {
      removeExternalAbort();
    }
  }

  async context(
    hostIdValue: string,
    sessionIdValue: string,
    args: TranscriptContextArguments,
    options: TranscriptSearchOptions = {},
  ): Promise<TranscriptContextResult> {
    const normalized = normalizeContextArguments(args);
    const plan = planHosts(this.runtime.getSnapshot());
    const eligible = plan.eligible.find((candidate) => candidate.hostId === hostIdValue);
    if (eligible === undefined) {
      const status = plan.statuses.get(hostIdValue)?.state;
      if (status === "offline" || status === undefined) {
        throw new TranscriptSearchError("offline", "transcript host is offline", hostIdValue);
      }
      throw new TranscriptSearchError(
        "unsupported",
        "transcript search is unsupported by this host",
        hostIdValue,
      );
    }
    const controller = new AbortController();
    const removeExternalAbort = this.forwardAbort(options.signal, controller);
    try {
      if (controller.signal.aborted) throw abortError();
      const command = this.issueContext(eligible, sessionId(sessionIdValue), normalized);
      const result = await Promise.race([command, this.abortPromise(controller.signal)]);
      if (controller.signal.aborted) throw abortError();
      if (result.accepted !== true) {
        throw new TranscriptSearchError(
          "command",
          "transcript context command failed",
          hostIdValue,
        );
      }
      try {
        return decodeTranscriptContextResult(result.result);
      } catch {
        throw new TranscriptSearchError(
          "command",
          "transcript context result was invalid",
          hostIdValue,
        );
      }
    } finally {
      removeExternalAbort();
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.current);
  }

  private abortPagination(): void {
    for (const run of this.pagination.values()) run.controller.abort();
    this.pagination.clear();
  }

  private issueSearch(host: EligibleHost, args: TranscriptSearchArguments): Promise<CommandResult> {
    const intent: CommandRequest["intent"] = {
      hostId: host.hostId,
      command: "transcript.search",
      args: { ...args },
    };
    return this.runtime.command(host.targetId, intent);
  }

  private issueContext(
    host: EligibleHost,
    contextSessionId: SessionId,
    args: TranscriptContextArguments,
  ): Promise<CommandResult> {
    const intent: CommandRequest["intent"] = {
      hostId: host.hostId,
      sessionId: contextSessionId,
      command: "transcript.context",
      args: { ...args },
    };
    return this.runtime.command(host.targetId, intent);
  }

  private forwardAbort(signal: AbortSignal | undefined, controller: AbortController): Unsubscribe {
    if (signal === undefined) return () => undefined;
    if (signal.aborted) {
      controller.abort();
      return () => undefined;
    }
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  private abortPromise(signal: AbortSignal): Promise<never> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }
}

export function createTranscriptSearchCoordinator(
  runtime: TranscriptSearchRuntime,
): TranscriptSearchCoordinator {
  return new TranscriptSearchCoordinator(runtime);
}
