import { AppWireError, type PairOkFrame, type ResultFrame, type ServerFrame, type WelcomeFrame } from "@t4-code/protocol";

type DurableFrame = Extract<ServerFrame, { type: "entry" | "event" | "session.delta" }>;
export function safeFrameDecodeFailure(error: unknown): string {
  if (!(error instanceof AppWireError)) return "invalid server frame";
  const safePath = error.path !== undefined && /^[A-Za-z0-9.[\]_-]{1,128}$/u.test(error.path) ? ` at ${error.path}` : "";
  return `invalid server frame (${error.code}${safePath})`;
}
export interface FrameDispatchHandlers {
  welcome(frame: WelcomeFrame): void;
  pong(nonce: string): void;
  bye(frame: Extract<ServerFrame, { type: "bye" }>): void;
  response(frame: ResultFrame): void;
  pairOk(frame: PairOkFrame, generation: number): void | Promise<void>;
  pairError(frame: Extract<ServerFrame, { type: "pair.error" }>): void;
  gap(frame: Extract<ServerFrame, { type: "gap" }>): void;
  snapshot(frame: Extract<ServerFrame, { type: "snapshot" }>): void;
  durable(frame: DurableFrame): void;
  other(frame: Exclude<ServerFrame, WelcomeFrame | ResultFrame | PairOkFrame | Extract<ServerFrame, { type: "bye" | "pong" | "pair.error" | "gap" | "snapshot" | "entry" | "event" | "session.delta" }>>): void;
}

/** Stable server-frame dispatch boundary; callbacks are constructed once per client. */
export class OmpClientFrameDispatcher {
  private readonly handlers: FrameDispatchHandlers;
  constructor(handlers: FrameDispatchHandlers) {
    this.handlers = handlers;
  }
  dispatch(frame: ServerFrame, generation: number): void | Promise<void> {
    switch (frame.type) {
      case "welcome": return this.handlers.welcome(frame);
      case "pong": return this.handlers.pong(frame.nonce);
      case "bye": return this.handlers.bye(frame);
      case "response": return this.handlers.response(frame);
      case "pair.ok": return this.handlers.pairOk(frame, generation);
      case "pair.error": return this.handlers.pairError(frame);
      case "gap": return this.handlers.gap(frame);
      case "snapshot": return this.handlers.snapshot(frame);
      case "entry":
      case "event":
      case "session.delta": return this.handlers.durable(frame);
      default: return this.handlers.other(frame);
    }
  }
}
import type { ClientFrame } from "@t4-code/protocol";
import type { CursorRecord, OmpClientOptions } from "./omp-client-contracts.ts";
import { buildOutgoingFrame } from "./omp-client-outbound.ts";
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
  let hello: ClientFrame | undefined;
  try {
    hello = buildOutgoingFrame(provider, {
      kind: "hello",
      client: options.client ?? { name: "t4-code", version: "0.1.22", build: "client", platform: "electron" },
      requestedFeatures: [...(options.requestedFeatures ?? ["resume"])],
      savedCursors,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(authentication === undefined ? {} : { authentication }),
    });
  } catch {
    protocolFailure();
    return;
  }
  if (hello === undefined || hello.type !== "hello") { protocolFailure(); return; }
  let encoded: string;
  try {
    encoded = provider.encodeClientFrame(hello);
  } catch {
    protocolFailure();
    return;
  }
  try {
    send(encoded);
  } catch (error) {
    transportFailure(error);
  }
}
