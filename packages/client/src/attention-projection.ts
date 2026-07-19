import { requiredCapability, type SessionRef } from "@t4-code/protocol";
import type { DesktopRuntimeSnapshot } from "./desktop-runtime-contracts.ts";
import type { ProjectionFreshness, SessionIndexMetadata } from "./projection.ts";

const MAX_PENDING_ITEMS = 8;
const MAX_QUESTION_OPTIONS = 32;
const MAX_ID_BYTES = 256;
const MAX_TITLE_BYTES = 256;
const MAX_SUMMARY_BYTES = 2_048;

export type AttentionGroup = "needs-you" | "problems" | "done";
export type AttentionPendingKind = "approval" | "question" | "plan";
export type AttentionOutcomeKind = "completed" | "failed" | "cancelled";
export type AttentionInventoryReason =
  | "inventory-not-fresh"
  | "inventory-missing"
  | "inventory-truncated"
  | "inventory-count-mismatch"
  | "attention-unavailable"
  | "attention-malformed"
  | "attention-truncated";
export type AttentionUnavailableReason =
  | "target-unavailable"
  | "host-disconnected"
  | "inventory-incomplete"
  | "session-stale"
  | "session-read-only"
  | "capability-missing"
  | "command-unsupported"
  | "item-replaced";
export type AttentionActionStatus = "ready" | "offline" | "observer" | "stale" | "unsupported";

export interface AttentionIdentity {
  readonly targetId?: string;
  readonly hostId: string;
  readonly sessionId?: string;
}

export interface AttentionSessionContext {
  readonly targetId?: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly title: string;
  /** Human-facing project label, falling back to the stable project id. */
  readonly project: string;
  readonly projectId: string;
  readonly projectName?: string;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface AttentionActionabilityInputs {
  readonly connected: boolean;
  readonly inventoryComplete: boolean;
  readonly projectionFresh: boolean;
  readonly writable: boolean;
  readonly capabilityGranted: boolean;
  readonly commandSupported: boolean;
  readonly revisionCurrent: boolean;
}

export type AttentionActionability =
  | {
      readonly available: true;
      readonly reason: null;
      readonly inputs: AttentionActionabilityInputs;
    }
  | {
      readonly available: false;
      readonly reason: AttentionUnavailableReason;
      readonly inputs: AttentionActionabilityInputs;
    };

interface AttentionItemBase {
  readonly key: string;
  readonly group: AttentionGroup;
  readonly identity: AttentionIdentity;
  readonly session: AttentionSessionContext;
  readonly title: string;
  readonly summary: string;
  readonly at: string;
  readonly atMs: number;
  readonly occurredAtMs: number;
  readonly freshness: ProjectionFreshness;
  readonly actionability: AttentionActionability;
  readonly actionState: {
    readonly status: AttentionActionStatus;
    readonly reason: AttentionUnavailableReason | null;
  };
  readonly seen: boolean;
}

export interface AttentionApprovalItem extends AttentionItemBase {
  readonly group: "needs-you";
  readonly kind: "approval";
  readonly requestId: string;
}

export interface AttentionQuestionOption {
  readonly id: string;
  readonly label: string;
}

export interface AttentionQuestionItem extends AttentionItemBase {
  readonly group: "needs-you";
  readonly kind: "question";
  readonly requestId: string;
  readonly question: string;
  readonly options: readonly AttentionQuestionOption[];
  readonly allowText: boolean;
  readonly multiple: false;
}

export interface AttentionPlanItem extends AttentionItemBase {
  readonly group: "needs-you";
  readonly kind: "plan";
  readonly requestId: string;
}

export interface AttentionConfirmationItem extends AttentionItemBase {
  readonly group: "needs-you";
  readonly kind: "confirmation";
  readonly requestId: string;
  readonly confirmationId: string;
  readonly commandId: string;
  readonly preview?: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
}

export interface AttentionOutcomeItem extends AttentionItemBase {
  readonly group: "problems" | "done";
  readonly kind: AttentionOutcomeKind;
  readonly outcomeId: string;
}

export type AttentionInboxItem =
  | AttentionApprovalItem
  | AttentionQuestionItem
  | AttentionPlanItem
  | AttentionConfirmationItem
  | AttentionOutcomeItem;
export type AttentionNeedsYouItem = Exclude<AttentionInboxItem, AttentionOutcomeItem>;

export interface AttentionInventoryIssue {
  readonly reason: AttentionInventoryReason;
  readonly hostId: string;
  readonly sessionId?: string;
}

export interface AttentionInventoryState {
  readonly partial: boolean;
  readonly omittedPendingCount: number;
  readonly issues: readonly AttentionInventoryIssue[];
}

export interface AttentionInboxProjection {
  readonly groups: {
    readonly needsYou: readonly AttentionNeedsYouItem[];
    readonly problems: readonly AttentionOutcomeItem[];
    readonly done: readonly AttentionOutcomeItem[];
  };
  /** Needs-you, Problems, then Done, with each group already sorted. */
  readonly items: readonly AttentionInboxItem[];
  /** Includes host-reported pending rows omitted from a truncated summary. */
  readonly urgentCount: number;
  readonly hasUnseenDone: boolean;
  readonly inventory: AttentionInventoryState;
}

export interface DeriveAttentionInboxOptions {
  readonly now?: number;
  readonly seenOutcomeKeys?: ReadonlySet<string>;
  /** Renderer-local read marker keyed by the host session id. */
  readonly seenOutcomeIdsBySessionKey?: Readonly<Record<string, string>>;
}

interface PendingApproval {
  readonly kind: "approval";
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly requestedAt: string;
}
interface PendingQuestion {
  readonly kind: "question";
  readonly id: string;
  readonly question: string;
  readonly options: readonly AttentionQuestionOption[];
  readonly allowText: boolean;
  readonly requestedAt: string;
}
interface PendingPlan {
  readonly kind: "plan";
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly requestedAt: string;
}
type PendingItem = PendingApproval | PendingQuestion | PendingPlan;
interface LatestOutcome {
  readonly id: string;
  readonly kind: AttentionOutcomeKind;
  readonly at: string;
  readonly summary: string;
}
interface SessionAttentionState {
  readonly pending: readonly PendingItem[];
  readonly pendingCount: number;
  readonly truncated: boolean;
  readonly latestOutcome?: LatestOutcome;
}
export type SessionAttentionRead =
  | { readonly status: "absent" }
  | { readonly status: "malformed" }
  | { readonly status: "valid"; readonly value: SessionAttentionState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function utf8Bytes(value: string): number {
  return typeof TextEncoder === "undefined" ? value.length : new TextEncoder().encode(value).byteLength;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || utf8Bytes(value) > maxBytes) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function boundedId(value: unknown): value is string {
  return boundedText(value, MAX_ID_BYTES) && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!boundedText(value, 128)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function decodeQuestionOption(value: unknown): AttentionQuestionOption | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "label"])) return undefined;
  if (!boundedId(value.id) || !boundedText(value.label, MAX_TITLE_BYTES)) return undefined;
  return Object.freeze({ id: value.id, label: value.label });
}

function decodePendingItem(value: unknown): PendingItem | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "approval" || value.kind === "plan") {
    if (!hasExactKeys(value, ["kind", "id", "title", "summary", "requestedAt"])) return undefined;
    if (
      !boundedId(value.id) ||
      !boundedText(value.title, MAX_TITLE_BYTES) ||
      !boundedText(value.summary, MAX_SUMMARY_BYTES) ||
      !canonicalTimestamp(value.requestedAt)
    ) return undefined;
    return Object.freeze({
      kind: value.kind,
      id: value.id,
      title: value.title,
      summary: value.summary,
      requestedAt: value.requestedAt,
    });
  }
  if (value.kind !== "question") return undefined;
  if (!hasExactKeys(value, ["kind", "id", "question", "options", "allowText", "requestedAt"])) {
    return undefined;
  }
  if (
    !boundedId(value.id) ||
    !boundedText(value.question, MAX_SUMMARY_BYTES) ||
    !Array.isArray(value.options) ||
    value.options.length > MAX_QUESTION_OPTIONS ||
    typeof value.allowText !== "boolean" ||
    !canonicalTimestamp(value.requestedAt)
  ) return undefined;
  const options = value.options.map(decodeQuestionOption);
  if (options.some((option) => option === undefined)) return undefined;
  const decoded = options as AttentionQuestionOption[];
  if (new Set(decoded.map((option) => option.id)).size !== decoded.length) return undefined;
  return Object.freeze({
    kind: "question",
    id: value.id,
    question: value.question,
    options: Object.freeze(decoded),
    allowText: value.allowText,
    requestedAt: value.requestedAt,
  });
}

function decodeLatestOutcome(value: unknown): LatestOutcome | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "kind", "at", "summary"])) return undefined;
  if (
    !boundedId(value.id) ||
    (value.kind !== "completed" && value.kind !== "failed" && value.kind !== "cancelled") ||
    !canonicalTimestamp(value.at) ||
    !boundedText(value.summary, MAX_SUMMARY_BYTES)
  ) return undefined;
  return Object.freeze({ id: value.id, kind: value.kind, at: value.at, summary: value.summary });
}

/**
 * Reads the additive field without depending on a newer app-wire type. A field
 * that exists but does not exactly match the known contract is never treated as
 * absence or partially interpreted.
 */
export function readSessionAttention(ref: unknown): SessionAttentionRead {
  if (!isRecord(ref) || !Object.hasOwn(ref, "attention")) return Object.freeze({ status: "absent" });
  const attention = ref.attention;
  if (
    !isRecord(attention) ||
    !hasExactKeys(attention, ["pending", "pendingCount", "truncated"], ["latestOutcome"]) ||
    !Array.isArray(attention.pending) ||
    attention.pending.length > MAX_PENDING_ITEMS ||
    !Number.isSafeInteger(attention.pendingCount) ||
    (attention.pendingCount as number) < attention.pending.length ||
    typeof attention.truncated !== "boolean" ||
    attention.truncated !== ((attention.pendingCount as number) > attention.pending.length)
  ) return Object.freeze({ status: "malformed" });
  const pending = attention.pending.map(decodePendingItem);
  if (pending.some((item) => item === undefined)) return Object.freeze({ status: "malformed" });
  const decodedPending = pending as PendingItem[];
  if (new Set(decodedPending.map((item) => `${item.kind}\u0000${item.id}`)).size !== decodedPending.length) {
    return Object.freeze({ status: "malformed" });
  }
  const latestOutcome = attention.latestOutcome === undefined
    ? undefined
    : decodeLatestOutcome(attention.latestOutcome);
  if (attention.latestOutcome !== undefined && latestOutcome === undefined) {
    return Object.freeze({ status: "malformed" });
  }
  return Object.freeze({
    status: "valid",
    value: Object.freeze({
      pending: Object.freeze(decodedPending),
      pendingCount: attention.pendingCount as number,
      truncated: attention.truncated,
      ...(latestOutcome === undefined ? {} : { latestOutcome }),
    }),
  });
}

function segment(value: string | undefined): string {
  return encodeURIComponent(value ?? "-");
}

function itemKey(
  identity: AttentionIdentity,
  kind: AttentionInboxItem["kind"],
  id: string,
): string {
  return `attention:${segment(identity.targetId)}:${segment(identity.hostId)}:${segment(identity.sessionId)}:${kind}:${segment(id)}`;
}

function targetForHost(snapshot: DesktopRuntimeSnapshot, hostId: string): string | undefined {
  const candidates = [...snapshot.targetHosts.entries()]
    .filter(([, candidateHostId]) => candidateHostId === hostId)
    .map(([targetId]) => targetId)
    .sort((left, right) => {
      const leftConnected = snapshot.connections.get(left) === "connected";
      const rightConnected = snapshot.connections.get(right) === "connected";
      return leftConnected === rightConnected ? left.localeCompare(right) : leftConnected ? -1 : 1;
    });
  return candidates[0];
}

function countIndexedSessions(snapshot: DesktopRuntimeSnapshot, hostId: string): number {
  let count = 0;
  for (const ref of snapshot.projection.sessionIndex.values()) {
    if (String(ref.hostId) === hostId) count += 1;
  }
  return count;
}

function inventoryComplete(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
  metadata: SessionIndexMetadata | undefined,
): boolean {
  return metadata !== undefined &&
    !metadata.truncated &&
    countIndexedSessions(snapshot, hostId) === metadata.totalCount;
}

function writableSession(ref: SessionRef): boolean {
  const record = ref as unknown as Record<string, unknown>;
  if (!isRecord(record.liveState) || !Object.hasOwn(record.liveState, "sessionControl")) return true;
  return false;
}

function commandSupported(snapshot: DesktopRuntimeSnapshot, hostId: string, command: string): boolean {
  const catalog = snapshot.catalogs.get(hostId);
  if (catalog === undefined) return true;
  const item = catalog.items.find((candidate) =>
    candidate.kind === "command" &&
    (String(candidate.id) === command || candidate.name === command));
  return item?.supported !== false;
}

function actionability(
  snapshot: DesktopRuntimeSnapshot,
  ref: SessionRef,
  targetId: string | undefined,
  command: "session.ui.respond" | "confirm",
  revisionCurrent: boolean,
): AttentionActionability {
  const hostId = String(ref.hostId);
  const connected = targetId !== undefined &&
    snapshot.connections.get(targetId) === "connected" &&
    snapshot.targetHosts.get(targetId) === hostId;
  const complete = inventoryComplete(snapshot, hostId, snapshot.projection.sessionIndexMetadata.get(hostId));
  const warm = snapshot.projection.sessions.get(`${hostId}\u0000${String(ref.sessionId)}`);
  const projectionFresh = snapshot.projection.freshness === "fresh" &&
    (warm === undefined || warm.freshness === "fresh");
  const writable = writableSession(ref);
  const required = command === "confirm" ? undefined : requiredCapability(command);
  const host = snapshot.hosts.get(hostId);
  const capabilityGranted = required === undefined || host?.grantedCapabilities.includes(required) === true;
  const supported = command === "confirm" || commandSupported(snapshot, hostId, command);
  const inputs: AttentionActionabilityInputs = Object.freeze({
    connected,
    inventoryComplete: complete,
    projectionFresh,
    writable,
    capabilityGranted,
    commandSupported: supported,
    revisionCurrent,
  });
  let reason: AttentionUnavailableReason | undefined;
  if (targetId === undefined) reason = "target-unavailable";
  else if (!connected) reason = "host-disconnected";
  else if (!complete) reason = "inventory-incomplete";
  else if (!projectionFresh) reason = "session-stale";
  else if (!writable) reason = "session-read-only";
  else if (!capabilityGranted) reason = "capability-missing";
  else if (!supported) reason = "command-unsupported";
  else if (!revisionCurrent) reason = "item-replaced";
  return reason === undefined
    ? Object.freeze({ available: true, reason: null, inputs })
    : Object.freeze({ available: false, reason, inputs });
}

function actionState(action: AttentionActionability): AttentionItemBase["actionState"] {
  let status: AttentionActionStatus = "ready";
  if (!action.available) {
    if (action.reason === "target-unavailable" || action.reason === "host-disconnected") status = "offline";
    else if (action.reason === "session-read-only") status = "observer";
    else if (action.reason === "capability-missing" || action.reason === "command-unsupported") status = "unsupported";
    else status = "stale";
  }
  return Object.freeze({ status, reason: action.reason });
}

function context(ref: SessionRef, targetId: string | undefined): AttentionSessionContext {
  const projectId = String(ref.project.projectId);
  return Object.freeze({
    ...(targetId === undefined ? {} : { targetId }),
    hostId: String(ref.hostId),
    sessionId: String(ref.sessionId),
    title: ref.title,
    project: ref.project.name ?? projectId,
    projectId,
    ...(ref.project.name === undefined ? {} : { projectName: ref.project.name }),
    revision: String(ref.revision),
    updatedAt: ref.updatedAt,
  });
}

function compareKeys(left: AttentionInboxItem, right: AttentionInboxItem): number {
  return left.key.localeCompare(right.key);
}

function sortNeedsYou(left: AttentionNeedsYouItem, right: AttentionNeedsYouItem): number {
  const leftExpiry = left.kind === "confirmation" ? left.expiresAtMs : Number.POSITIVE_INFINITY;
  const rightExpiry = right.kind === "confirmation" ? right.expiresAtMs : Number.POSITIVE_INFINITY;
  return leftExpiry - rightExpiry || left.atMs - right.atMs || compareKeys(left, right);
}

function sortNewest(left: AttentionOutcomeItem, right: AttentionOutcomeItem): number {
  return right.atMs - left.atMs || compareKeys(left, right);
}

function freezeIdentity(targetId: string | undefined, hostId: string, sessionId?: string): AttentionIdentity {
  return Object.freeze({ ...(targetId === undefined ? {} : { targetId }), hostId, ...(sessionId === undefined ? {} : { sessionId }) });
}

function appendIssue(
  issues: AttentionInventoryIssue[],
  seen: Set<string>,
  reason: AttentionInventoryReason,
  hostId: string,
  sessionId?: string,
): void {
  const key = `${reason}\u0000${hostId}\u0000${sessionId ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push(Object.freeze({ reason, hostId, ...(sessionId === undefined ? {} : { sessionId }) }));
}

export function deriveAttentionInbox(
  snapshot: DesktopRuntimeSnapshot,
  options: DeriveAttentionInboxOptions = {},
): AttentionInboxProjection {
  const now = options.now ?? Date.now();
  const seenOutcomeKeys = options.seenOutcomeKeys ?? new Set<string>();
  const seenOutcomeIdsBySessionKey = options.seenOutcomeIdsBySessionKey ?? {};
  const needsYou: AttentionNeedsYouItem[] = [];
  const problems: AttentionOutcomeItem[] = [];
  const done: AttentionOutcomeItem[] = [];
  const issues: AttentionInventoryIssue[] = [];
  const issueKeys = new Set<string>();
  let omittedPendingCount = 0;

  const knownHosts = new Set<string>([
    ...snapshot.targetHosts.values(),
    ...[...snapshot.projection.sessionIndex.values()].map((ref) => String(ref.hostId)),
    ...snapshot.projection.sessionIndexMetadata.keys(),
  ]);
  if (snapshot.projection.freshness !== "fresh") {
    for (const hostId of knownHosts) appendIssue(issues, issueKeys, "inventory-not-fresh", hostId);
  }
  for (const hostId of knownHosts) {
    const metadata = snapshot.projection.sessionIndexMetadata.get(hostId);
    if (metadata === undefined) appendIssue(issues, issueKeys, "inventory-missing", hostId);
    else {
      if (metadata.truncated) appendIssue(issues, issueKeys, "inventory-truncated", hostId);
      if (countIndexedSessions(snapshot, hostId) !== metadata.totalCount) {
        appendIssue(issues, issueKeys, "inventory-count-mismatch", hostId);
      }
    }
  }

  for (const ref of snapshot.projection.sessionIndex.values()) {
    const hostId = String(ref.hostId);
    const sessionId = String(ref.sessionId);
    const targetId = targetForHost(snapshot, hostId);
    const identity = freezeIdentity(targetId, hostId, sessionId);
    const session = context(ref, targetId);
    const attention = readSessionAttention(ref);
    if (attention.status === "absent") {
      appendIssue(issues, issueKeys, "attention-unavailable", hostId, sessionId);
      continue;
    }
    if (attention.status === "malformed") {
      appendIssue(issues, issueKeys, "attention-malformed", hostId, sessionId);
      continue;
    }
    if (attention.value.truncated) {
      omittedPendingCount += attention.value.pendingCount - attention.value.pending.length;
      appendIssue(issues, issueKeys, "attention-truncated", hostId, sessionId);
    }
    const respondActionability = actionability(snapshot, ref, targetId, "session.ui.respond", true);
    for (const item of attention.value.pending) {
      const key = itemKey(identity, item.kind, item.id);
      const base = {
        key,
        group: "needs-you" as const,
        identity,
        session,
        title: item.kind === "question" ? "Question" : item.title,
        summary: item.kind === "question" ? item.question : item.summary,
        at: item.requestedAt,
        atMs: Date.parse(item.requestedAt),
        occurredAtMs: Date.parse(item.requestedAt),
        freshness: snapshot.projection.freshness,
        actionability: respondActionability,
        actionState: actionState(respondActionability),
        seen: false,
      };
      if (item.kind === "question") {
        needsYou.push(Object.freeze({
          ...base,
          kind: "question",
          requestId: item.id,
          question: item.question,
          options: item.options,
          allowText: item.allowText,
          multiple: false,
        }));
      } else {
        needsYou.push(Object.freeze({
          ...base,
          kind: item.kind,
          requestId: item.id,
          title: item.title,
          summary: item.summary,
        }));
      }
    }
    const outcome = attention.value.latestOutcome;
    if (outcome !== undefined) {
      const key = itemKey(identity, outcome.kind, outcome.id);
      const group = outcome.kind === "completed" ? "done" : "problems";
      const output: AttentionOutcomeItem = Object.freeze({
        key,
        group,
        kind: outcome.kind,
        outcomeId: outcome.id,
        identity,
        session,
        title: outcome.kind === "completed" ? "Completed" : outcome.kind === "failed" ? "Failed" : "Cancelled",
        summary: outcome.summary,
        at: outcome.at,
        atMs: Date.parse(outcome.at),
        occurredAtMs: Date.parse(outcome.at),
        freshness: snapshot.projection.freshness,
        actionability: respondActionability,
        actionState: actionState(respondActionability),
        seen:
          seenOutcomeKeys.has(key) ||
          seenOutcomeIdsBySessionKey[`${hostId}\u0000${sessionId}`] === outcome.id,
      });
      if (group === "done") done.push(output);
      else problems.push(output);
    }
  }

  // Confirmation challenges are intentionally read only from warm live state.
  // The durable cache clears this map, so reconnect cannot revive a dead action.
  for (const warm of snapshot.projection.sessions.values()) {
    const ref = snapshot.projection.sessionIndex.get(`${warm.hostId}\u0000${warm.sessionId}`) ?? warm.ref;
    if (ref === undefined) continue;
    const targetId = targetForHost(snapshot, warm.hostId);
    for (const challenge of warm.confirmations.values()) {
      const raw = challenge as unknown as Record<string, unknown>;
      if (
        !boundedId(raw.confirmationId) ||
        !boundedId(raw.commandId) ||
        !boundedText(raw.summary, MAX_SUMMARY_BYTES) ||
        !canonicalTimestamp(raw.expiresAt) ||
        !boundedId(raw.revision)
      ) continue;
      const expiresAtMs = Date.parse(raw.expiresAt);
      if (expiresAtMs <= now) continue;
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : warm.sessionId;
      if (sessionId !== warm.sessionId || String(raw.hostId) !== warm.hostId) continue;
      const identity = freezeIdentity(targetId, warm.hostId, warm.sessionId);
      const key = itemKey(identity, "confirmation", raw.confirmationId);
      const revisionCurrent = raw.revision === String(ref.revision) && warm.revision === String(ref.revision);
      const confirmationActionability = actionability(snapshot, ref, targetId, "confirm", revisionCurrent);
      needsYou.push(Object.freeze({
        key,
        group: "needs-you",
        kind: "confirmation",
        requestId: raw.confirmationId,
        confirmationId: raw.confirmationId,
        commandId: raw.commandId,
        identity,
        session: context(ref, targetId),
        title: "Confirmation required",
        summary: raw.summary,
        ...(boundedText(raw.preview, 8_192) ? { preview: raw.preview } : {}),
        expiresAt: raw.expiresAt,
        expiresAtMs,
        at: raw.expiresAt,
        atMs: expiresAtMs,
        occurredAtMs: expiresAtMs,
        freshness: warm.freshness,
        actionability: confirmationActionability,
        actionState: actionState(confirmationActionability),
        seen: false,
      }));
    }
  }

  needsYou.sort(sortNeedsYou);
  problems.sort(sortNewest);
  done.sort(sortNewest);
  const frozenNeeds = Object.freeze(needsYou);
  const frozenProblems = Object.freeze(problems);
  const frozenDone = Object.freeze(done);
  return Object.freeze({
    groups: Object.freeze({ needsYou: frozenNeeds, problems: frozenProblems, done: frozenDone }),
    items: Object.freeze([...frozenNeeds, ...frozenProblems, ...frozenDone]),
    urgentCount: frozenNeeds.length + omittedPendingCount + frozenProblems.filter((item) => !item.seen).length,
    hasUnseenDone: frozenDone.some((item) => !item.seen),
    inventory: Object.freeze({
      partial: issues.length > 0,
      omittedPendingCount,
      issues: Object.freeze(issues),
    }),
  });
}
