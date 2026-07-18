import {
  hostId as brandHostId,
  revision as brandRevision,
  sessionId as brandSessionId,
} from "@t4-code/protocol";
import type {
  CommandIntent,
  CommandResult,
  ConfirmRequest,
  ConfirmResult,
  RendererServerEventEnvelope,
} from "@t4-code/protocol/desktop-ipc";

const AGENT_CANCEL_CHALLENGE_TIMEOUT_MS = 10_000;
const agentCancelRuns = new Map<string, Promise<void>>();

export interface AgentCancelAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

/** The narrow runtime seam needed to confirm an agent cancellation. */
export interface AgentCancelRuntime {
  command(targetId: string, intent: CommandIntent): Promise<CommandResult>;
  confirm(request: ConfirmRequest): Promise<ConfirmResult>;
  subscribeEvents(
    filter: {
      targetId: string;
      hostId?: string;
      sessionId?: string;
      kinds?: readonly string[];
    },
    listener: (event: RendererServerEventEnvelope) => void,
  ): () => void;
}

export interface ConfirmedAgentCancel {
  readonly address: AgentCancelAddress;
  readonly agentId: string;
  /** Throws unless the caller can still safely write this session. */
  assertWritable(): void;
  /** Returns the current authoritative session revision or throws. */
  currentRevision(): string;
}

interface AgentCancelChallenge {
  readonly confirmationId: ConfirmRequest["confirmationId"];
  readonly commandId: ConfirmRequest["commandId"];
  readonly hostId: ConfirmRequest["hostId"];
  readonly sessionId: NonNullable<ConfirmRequest["sessionId"]>;
  readonly commandHash: string;
  readonly revision: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function matchingAgentCancelChallenge(
  payload: unknown,
  address: AgentCancelAddress,
  expectedRevision: string,
): payload is AgentCancelChallenge {
  if (payload === null || typeof payload !== "object") return false;
  const challenge = payload as Partial<AgentCancelChallenge> & { readonly summary?: unknown };
  return (
    challenge.summary === "agent.cancel" &&
    String(challenge.hostId) === address.hostId &&
    String(challenge.sessionId) === address.sessionId &&
    String(challenge.revision) === expectedRevision &&
    nonEmptyString(challenge.confirmationId) &&
    nonEmptyString(challenge.commandId) &&
    nonEmptyString(challenge.commandHash)
  );
}

function assertAccepted(result: Pick<CommandResult | ConfirmResult, "accepted">, message: string): void {
  if (!result.accepted) throw new Error(message);
}

async function runConfirmedAgentCancelNow(
  runtime: AgentCancelRuntime,
  operation: ConfirmedAgentCancel,
): Promise<void> {
  // Queue turns can span another caller's confirmation round-trip. Establish
  // ownership/freshness and the revision only once this call owns the turn.
  operation.assertWritable();
  const expectedRevision = operation.currentRevision();
  const { address } = operation;

  let stopChallengeWait: () => void = () => undefined;
  let listenerReady = true;
  const challenge = new Promise<AgentCancelChallenge>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    let settled = false;
    const finish = (value?: AgentCancelChallenge, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error === undefined && value !== undefined) resolve(value);
      else reject(error ?? new Error("The host did not issue the expected agent cancellation confirmation."));
    };
    const timeout = setTimeout(
      () => finish(undefined, new Error("The host did not issue the expected agent cancellation confirmation.")),
      AGENT_CANCEL_CHALLENGE_TIMEOUT_MS,
    );
    try {
      unsubscribe = runtime.subscribeEvents(
        {
          targetId: address.targetId,
          hostId: address.hostId,
          sessionId: address.sessionId,
          kinds: ["confirmation"],
        },
        (event) => {
          if (
            event.targetId !== address.targetId ||
            event.event.kind !== "confirmation" ||
            !matchingAgentCancelChallenge(event.event.payload, address, expectedRevision)
          ) {
            return;
          }
          finish(event.event.payload);
        },
      );
      if (settled) unsubscribe();
    } catch (error) {
      listenerReady = false;
      finish(
        undefined,
        error instanceof Error
          ? error
          : new Error("Unable to subscribe for the agent cancellation confirmation."),
      );
    }
    stopChallengeWait = () => finish(undefined, new Error("The agent cancellation confirmation was cancelled."));
  });

  try {
    if (!listenerReady) {
      await challenge;
      throw new Error("Unable to subscribe for the agent cancellation confirmation.");
    }
    const command = runtime.command(address.targetId, {
      hostId: brandHostId(address.hostId),
      sessionId: brandSessionId(address.sessionId),
      command: "agent.cancel",
      args: { agentId: operation.agentId },
      expectedRevision: brandRevision(expectedRevision),
    });
    const hostChallenge = await Promise.race([
      challenge,
      command.then((result) => {
        assertAccepted(result, "The host did not accept this cancellation request.");
        throw new Error("The host completed agent cancellation without its required confirmation.");
      }),
    ]);

    operation.assertWritable();
    if (operation.currentRevision() !== expectedRevision) {
      throw new Error("The session changed before agent cancellation could be confirmed.");
    }

    const confirmation = await runtime.confirm({
      targetId: address.targetId,
      confirmationId: hostChallenge.confirmationId,
      commandId: hostChallenge.commandId,
      hostId: hostChallenge.hostId,
      sessionId: hostChallenge.sessionId,
      decision: "approve",
    });
    assertAccepted(confirmation, "The host rejected this agent cancellation confirmation.");
    assertAccepted(await command, "The host did not accept this cancellation request.");
  } finally {
    stopChallengeWait();
  }
}

/**
 * Serialize each target/host/session tuple so renderers can correlate a
 * challenge whose wire shape intentionally omits the agent id.
 */
export async function cancelConfirmedAgent(
  runtime: AgentCancelRuntime,
  operation: ConfirmedAgentCancel,
): Promise<void> {
  const { address } = operation;
  const key = `${address.targetId}\u0000${address.hostId}\u0000${address.sessionId}`;
  const previous = agentCancelRuns.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => runConfirmedAgentCancelNow(runtime, operation));
  agentCancelRuns.set(key, run);
  try {
    await run;
  } finally {
    if (agentCancelRuns.get(key) === run) agentCancelRuns.delete(key);
  }
}
