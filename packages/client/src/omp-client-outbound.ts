import {
  PROTOCOL_VERSION,
  decodeClientFrame,
  type ClientFrame,
} from "@t4-code/protocol";

import type { CommandIntent } from "./omp-client-contracts.ts";

export function buildCommandFrameInput(
  intent: CommandIntent,
  requestId: string,
  commandId: string,
): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "command",
    requestId,
    commandId,
    hostId: intent.hostId,
    ...(intent.sessionId === undefined ? {} : { sessionId: intent.sessionId }),
    command: intent.command,
    ...(intent.expectedRevision === undefined ? {} : { expectedRevision: intent.expectedRevision }),
    ...(intent.confirmationId === undefined ? {} : { confirmationId: intent.confirmationId }),
    args:
      intent.command === "session.prompt" && intent.args?.message === undefined
        ? typeof intent.args?.text === "string"
          ? { ...intent.args, message: intent.args.text }
          : typeof intent.args?.prompt === "string"
            ? { ...intent.args, message: intent.args.prompt }
            : intent.args && Object.keys(intent.args).length === 0
              ? { message: "" }
              : (intent.args ?? {})
        : (intent.args ?? {}),
  };
}

export function decodeOutgoingFrame(input: Record<string, unknown>): ClientFrame | undefined {
  try {
    return decodeClientFrame(input);
  } catch {
    return undefined;
  }
}
