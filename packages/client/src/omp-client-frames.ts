import { AppWireError } from "@t4-code/protocol";
import type { OmpDecodedServerEvent } from "./omp-protocol-provider.ts";

type DecodedEvent<Kind extends OmpDecodedServerEvent["kind"]> = Extract<OmpDecodedServerEvent, { kind: Kind }>;
type DurableEvent = DecodedEvent<"entry" | "event" | "session.delta">;
export function safeFrameDecodeFailure(error: unknown): string {
  if (!(error instanceof AppWireError)) return "invalid server frame";
  const safePath = error.path !== undefined && /^[A-Za-z0-9.[\]_-]{1,128}$/u.test(error.path) ? ` at ${error.path}` : "";
  return `invalid server frame (${error.code}${safePath})`;
}
export interface FrameDispatchHandlers {
  welcome(message: DecodedEvent<"welcome">): void;
  pong(nonce: string): void;
  bye(message: DecodedEvent<"bye">): void;
  response(message: DecodedEvent<"response">): void;
  pairOk(message: DecodedEvent<"pair.ok">, generation: number): void | Promise<void>;
  pairError(message: DecodedEvent<"pair.error">): void;
  gap(message: DecodedEvent<"gap">): void;
  snapshot(message: DecodedEvent<"snapshot">): void;
  durable(message: DurableEvent): void;
  other(message: Exclude<OmpDecodedServerEvent, DecodedEvent<"welcome" | "response" | "pair.ok" | "bye" | "pong" | "pair.error" | "gap" | "snapshot" | "entry" | "event" | "session.delta">>): void;
}

/** Stable server-event dispatch boundary; callbacks are constructed once per client. */
export class OmpClientEventDispatcher {
  private readonly handlers: FrameDispatchHandlers;
  constructor(handlers: FrameDispatchHandlers) {
    this.handlers = handlers;
  }
  dispatch(message: OmpDecodedServerEvent, generation: number): void | Promise<void> {
    switch (message.kind) {
      case "welcome": return this.handlers.welcome(message);
      case "pong": return this.handlers.pong(message.payload.nonce);
      case "bye": return this.handlers.bye(message);
      case "response": return this.handlers.response(message);
      case "pair.ok": return this.handlers.pairOk(message, generation);
      case "pair.error": return this.handlers.pairError(message);
      case "gap": return this.handlers.gap(message);
      case "snapshot": return this.handlers.snapshot(message);
      case "entry":
      case "event":
      case "session.delta": return this.handlers.durable(message);
      default: return this.handlers.other(message);
    }
  }
}
import type { CursorRecord, OmpClientOptions } from "./omp-client-contracts.ts";
import { encodeOutgoingMessage } from "./omp-client-outbound.ts";
import type { OmpProtocolProvider } from "./omp-protocol-provider.ts";

export function sendClientHello(
  provider: OmpProtocolProvider,
  options: OmpClientOptions,
  records: readonly CursorRecord[],
  send: (encoded: string) => void,
  fatal: () => void,
  protocolFailure: () => void,
  transportFailure: (error: unknown) => void,
): void {
  const savedCursors = records.slice(0, 128).map((record) => ({ ...record }));
  let authentication: { deviceId: string; deviceToken: string } | undefined;
  try {
    const provided = options.authentication?.();
    if (provided !== undefined) {
      if (typeof provided.deviceId !== "string" || provided.deviceId.length === 0 || provided.deviceId.length > 256 || typeof provided.deviceToken !== "string" || provided.deviceToken.length === 0 || provided.deviceToken.length > 512) throw new Error("invalid authentication");
      authentication = { deviceId: provided.deviceId, deviceToken: provided.deviceToken };
    }
  } catch { fatal(); return; }
  const encoded = encodeOutgoingMessage(provider, {
    kind: "hello",
    client: options.client ?? { name: "t4-code", version: "0.1.22", build: "client", platform: "electron" },
    requestedFeatures: [...(options.requestedFeatures ?? ["resume"])],
    savedCursors,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(authentication === undefined ? {} : { authentication }),
  });
  if (encoded === undefined) { protocolFailure(); return; }
  try {
    send(encoded);
  } catch (error) {
    transportFailure(error);
  }
}
