import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  hostId,
  revision,
  sessionId,
  type ConfirmationChallenge,
  type SessionRef,
} from "@t4-code/protocol";
import type { CommandResult } from "@t4-code/protocol/desktop-ipc";

import type { LiveProjectAddress, LiveSessionAddress } from "../../platform/live-workspace.ts";
import { commandSupport } from "./session-controls.ts";
import { sessionActionRejectionReason } from "./command-errors.ts";

export type SessionManagementCommand =
  | "session.rename"
  | "session.archive"
  | "session.restore"
  | "session.close"
  | "session.delete";

export interface SessionManagementSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

const CONVERGENCE_TIMEOUT_MS = 10_000;
const challengedManagementRuns = new Map<string, Promise<void>>();

export function sessionCreateSupport(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveProjectAddress,
): SessionManagementSupport {
  if (snapshot.connections.get(address.targetId) !== "connected") {
    return { supported: false, reason: "Connect to this host to create a session" };
  }
  const host = snapshot.hosts.get(address.hostId);
  const granted = host?.grantedCapabilities ?? [];
  if (!granted.includes("sessions.manage")) {
    return { supported: false, reason: "Session creation is not granted on this host" };
  }
  const catalog = commandSupport(snapshot.catalogs.get(address.hostId), granted, "session.create");
  return catalog.supported
    ? { supported: true, reason: null }
    : {
        supported: false,
        reason:
          catalog.reason === "This host can't change this from here yet — use the terminal"
            ? "This host does not offer session creation yet"
            : catalog.reason,
      };
}

function sessionKey(address: LiveSessionAddress): string {
  return `${address.hostId}\u0000${address.sessionId}`;
}

export function sessionRefForAddress(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveSessionAddress,
): SessionRef | undefined {
  return snapshot.projection.sessionIndex.get(sessionKey(address));
}

/** Canonical archive authority is the optional ISO timestamp on SessionRef. */
export function sessionArchivedAt(ref: SessionRef | undefined): string | null {
  if (ref === undefined) return null;
  const value = ref.archivedAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function sessionIsArchived(ref: SessionRef | undefined): boolean {
  return sessionArchivedAt(ref) !== null;
}

export function sessionIsClosed(ref: SessionRef | undefined): boolean {
  return ref?.status === "closed";
}

export function sessionIsWorking(ref: SessionRef | undefined): boolean {
  if (ref === undefined) return false;
  const rawRef = ref as unknown as Record<string, unknown>;
  if (
    ref.status === "active" ||
    ref.pendingApproval === true ||
    ref.pendingUserInput === true ||
    rawRef.working === true ||
    rawRef.isWorking === true ||
    rawRef.turnActive === true ||
    rawRef.inFlight === true ||
    (typeof rawRef.queuedMessageCount === "number" && rawRef.queuedMessageCount > 0) ||
    (Array.isArray(rawRef.queuedMessages) && rawRef.queuedMessages.length > 0)
  ) {
    return true;
  }
  const liveState = ref?.liveState;
  if (liveState === undefined || liveState === null || typeof liveState !== "object") return false;
  const live = liveState as Record<string, unknown>;
  const phase = live.phase;
  return (
    phase === "working" ||
    phase === "running" ||
    phase === "active" ||
    phase === "streaming" ||
    phase === "compacting" ||
    phase === "queued" ||
    phase === "waiting" ||
    phase === "awaiting-input" ||
    phase === "awaiting_input" ||
    live.working === true ||
    live.isWorking === true ||
    live.isRunning === true ||
    live.turnActive === true ||
    live.inFlight === true ||
    live.isStreaming === true ||
    live.isCompacting === true ||
    live.pendingApproval === true ||
    live.pendingUserInput === true ||
    (typeof live.queuedMessageCount === "number" && live.queuedMessageCount > 0) ||
    (typeof live.queue === "number" && live.queue > 0) ||
    (Array.isArray(live.queuedMessages) && live.queuedMessages.length > 0) ||
    (Array.isArray(live.queue) && live.queue.length > 0)
  );
}

export function managementCommandSupport(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveSessionAddress,
  command: SessionManagementCommand,
): SessionManagementSupport {
  if (snapshot.connections.get(address.targetId) !== "connected") {
    return { supported: false, reason: "Connect to this host to manage the session" };
  }
  const host = snapshot.hosts.get(address.hostId);
  const granted = host?.grantedCapabilities ?? [];
  if (!granted.includes("sessions.manage")) {
    return { supported: false, reason: "Session management is not granted on this host" };
  }
  const catalog = commandSupport(snapshot.catalogs.get(address.hostId), granted, command);
  if (!catalog.supported) {
    return {
      supported: false,
      reason:
        catalog.reason === "This host can't change this from here yet — use the terminal"
          ? "This host does not offer this session action yet"
          : catalog.reason,
    };
  }
  const ref = sessionRefForAddress(snapshot, address);
  if (command === "session.rename" && sessionIsArchived(ref)) {
    return { supported: false, reason: "Restore this session before renaming it" };
  }
  if (command === "session.close" && sessionIsArchived(ref)) {
    return { supported: false, reason: "Restore this session before terminating its runtime" };
  }
  if ((command === "session.archive" || command === "session.delete") && sessionIsWorking(ref)) {
    return { supported: false, reason: "Terminate the runtime before archiving or deleting it" };
  }
  return { supported: true, reason: null };
}

function assertAccepted(
  response: Pick<CommandResult, "accepted" | "result" | "error">,
  resultKey: "renamed" | "archived" | "restored" | "closed" | "deleted" | null,
): void {
  if (!response.accepted) {
    throw new Error(
      sessionActionRejectionReason(response.error, resultKey === "closed" ? "terminate" : "manage"),
    );
  }
  if (resultKey === null) return;
  const result = response.result;
  if (
    result === null ||
    typeof result !== "object" ||
    (result as Record<string, unknown>)[resultKey] !== true
  ) {
    throw new Error("The host returned an invalid session action result.");
  }
}

interface ConvergenceWaiter {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
}

function waitForAuthority(
  controller: DesktopRuntimeController,
  predicate: (snapshot: DesktopRuntimeSnapshot) => boolean,
): ConvergenceWaiter {
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveWait: () => void = () => undefined;
  let rejectWait: (error: Error) => void = () => undefined;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    if (timeout !== undefined) clearTimeout(timeout);
    if (error === undefined) resolveWait();
    else rejectWait(error);
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const inspect = (snapshot: DesktopRuntimeSnapshot) => {
    if (predicate(snapshot)) finish();
  };
  unsubscribe = controller.subscribe(inspect);
  timeout = setTimeout(
    () => finish(new Error("The host accepted the action, but the session list did not refresh.")),
    CONVERGENCE_TIMEOUT_MS,
  );
  inspect(controller.getSnapshot());
  return { promise, cancel: () => finish() };
}

async function refreshSessionList(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  predicate: (snapshot: DesktopRuntimeSnapshot) => boolean,
): Promise<void> {
  const waiter = waitForAuthority(controller, predicate);
  try {
    const response = await controller.command(address.targetId, {
      hostId: hostId(address.hostId),
      command: "session.list",
      args: {},
    });
    assertAccepted(response, null);
    await waiter.promise;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
}

function currentRevision(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): string {
  const ref = sessionRefForAddress(controller.getSnapshot(), address);
  if (ref === undefined) throw new Error("This session is no longer available.");
  return String(ref.revision);
}

export async function renameLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("Enter a session name.");
  if (sessionIsArchived(sessionRefForAddress(controller.getSnapshot(), address))) {
    throw new Error("Restore this session before renaming it.");
  }
  const expectedRevision = currentRevision(controller, address);
  const response = await controller.commandWithControllerLease(address.targetId, {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command: "session.rename",
    expectedRevision: revision(expectedRevision),
    args: { name: trimmed },
  });
  assertAccepted(response, "renamed");
  await refreshSessionList(controller, address, (snapshot) => {
    const ref = sessionRefForAddress(snapshot, address);
    return ref?.title === trimmed && String(ref.revision) !== expectedRevision;
  });
}

async function runUnchallengedManagementCommand(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  command: "session.archive" | "session.restore",
): Promise<void> {
  const expectedRevision = currentRevision(controller, address);
  const ref = sessionRefForAddress(controller.getSnapshot(), address);
  if (command === "session.archive" && sessionIsWorking(ref)) {
    throw new Error("Terminate the runtime before archiving or deleting it.");
  }
  const response = await controller.command(address.targetId, {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command,
    expectedRevision: revision(expectedRevision),
    args: {},
  });
  assertAccepted(response, command === "session.archive" ? "archived" : "restored");
  await refreshSessionList(controller, address, (snapshot) => {
    const next = sessionRefForAddress(snapshot, address);
    if (next === undefined) return false;
    return command === "session.archive" ? sessionIsArchived(next) : !sessionIsArchived(next);
  });
}

export async function archiveLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runUnchallengedManagementCommand(controller, address, "session.archive");
}

export async function restoreLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runUnchallengedManagementCommand(controller, address, "session.restore");
}

function matchingManagementChallenge(
  frame: unknown,
  address: LiveSessionAddress,
  expectedRevision: string,
  command: "session.close" | "session.delete",
): frame is ConfirmationChallenge {
  if (frame === null || typeof frame !== "object") return false;
  const challenge = frame as Partial<ConfirmationChallenge>;
  return (
    challenge.type === "confirmation" &&
    String(challenge.hostId) === address.hostId &&
    String(challenge.sessionId) === address.sessionId &&
    challenge.summary === command &&
    String(challenge.revision) === expectedRevision &&
    typeof challenge.commandHash === "string" &&
    challenge.commandHash.length > 0
  );
}

async function runChallengedManagementCommandNow(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  commandName: "session.close" | "session.delete",
): Promise<void> {
  const expectedRevision = currentRevision(controller, address);
  const current = sessionRefForAddress(controller.getSnapshot(), address);
  if (commandName === "session.close" && sessionIsArchived(current)) {
    throw new Error("Restore this session before terminating its runtime.");
  }
  if (commandName === "session.delete" && sessionIsWorking(current)) {
    throw new Error("Terminate the runtime before archiving or deleting it.");
  }

  // Acquire before listening for the destructive-command challenge. Otherwise
  // a same-session challenge can arrive while lease acquisition is pending and
  // be mistaken for the command this call has not sent yet.
  const lease =
    commandName === "session.close"
      ? await controller.acquireControllerLease(
          address.targetId,
          address.hostId,
          address.sessionId,
          expectedRevision,
        )
      : { required: false as const };

  let stopChallengeWait = () => undefined;
  const challenge = new Promise<ConfirmationChallenge>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stopChallengeWait();
      reject(
        new Error(
          `The host did not issue the expected ${commandName === "session.close" ? "runtime termination" : "delete"} confirmation.`,
        ),
      );
    }, CONVERGENCE_TIMEOUT_MS);
    let unsubscribe: () => void = () => undefined;
    unsubscribe = controller.subscribeFrames(
      {
        targetId: address.targetId,
        hostId: address.hostId,
        sessionId: address.sessionId,
        types: ["confirmation"],
      },
      (event) => {
        if (!matchingManagementChallenge(event.frame, address, expectedRevision, commandName))
          return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(event.frame);
      },
    );
    stopChallengeWait = () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  });

  const intent = {
    hostId: hostId(address.hostId),
    sessionId: sessionId(address.sessionId),
    command: commandName,
    expectedRevision: revision(expectedRevision),
    args: lease.required ? { leaseId: lease.leaseId } : {},
  } as const;
  const command = controller.command(address.targetId, intent);
  try {
    const hostChallenge = await Promise.race([
      challenge,
      command.then((response) => {
        if (!response.accepted) {
          assertAccepted(response, commandName === "session.close" ? "closed" : "deleted");
        }
        throw new Error(
          `The host completed ${commandName === "session.close" ? "runtime termination" : "deletion"} without its required challenge.`,
        );
      }),
    ]);
    const confirmation = await controller.confirm({
      targetId: address.targetId,
      confirmationId: hostChallenge.confirmationId,
      commandId: hostChallenge.commandId,
      hostId: hostChallenge.hostId,
      ...(hostChallenge.sessionId === undefined ? {} : { sessionId: hostChallenge.sessionId }),
      decision: "approve",
    });
    if (!confirmation.accepted) {
      throw new Error(
        `The host rejected the ${commandName === "session.close" ? "runtime termination" : "delete"} confirmation.`,
      );
    }
    assertAccepted(await command, commandName === "session.close" ? "closed" : "deleted");
  } finally {
    stopChallengeWait();
  }

  await refreshSessionList(controller, address, (snapshot) => {
    const next = sessionRefForAddress(snapshot, address);
    return commandName === "session.close"
      ? sessionIsClosed(next) && !sessionIsWorking(next)
      : next === undefined;
  });
}

async function runChallengedManagementCommand(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
  commandName: "session.close" | "session.delete",
): Promise<void> {
  const key = `${address.targetId}\u0000${sessionKey(address)}`;
  const previous = challengedManagementRuns.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => runChallengedManagementCommandNow(controller, address, commandName));
  challengedManagementRuns.set(key, operation);
  try {
    await operation;
  } finally {
    if (challengedManagementRuns.get(key) === operation) challengedManagementRuns.delete(key);
  }
}

export async function terminateLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runChallengedManagementCommand(controller, address, "session.close");
}

export async function deleteLiveSession(
  controller: DesktopRuntimeController,
  address: LiveSessionAddress,
): Promise<void> {
  await runChallengedManagementCommand(controller, address, "session.delete");
}
