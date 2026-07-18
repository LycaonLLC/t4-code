import type { ClientFrame } from "@t4-code/protocol";

import type { OmpClientMessage, OmpProtocolProvider } from "./omp-protocol-provider.ts";

export function buildOutgoingFrame(
  provider: OmpProtocolProvider,
  message: OmpClientMessage,
): ClientFrame | undefined {
  try {
    return provider.buildClientFrame(message);
  } catch {
    return undefined;
  }
}
