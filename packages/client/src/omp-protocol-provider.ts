import type {
  ClientFrame,
  CommandDescriptor,
  Cursor,
  DeviceCapability,
  ServerFrame,
} from "@t4-code/protocol";

/** Messages the T4 client can ask a concrete protocol adapter to send. */
export type OmpClientMessage =
  | {
      readonly kind: "hello";
      readonly client: { readonly name: string; readonly version: string; readonly build: string; readonly platform: string };
      readonly requestedFeatures: readonly string[];
      readonly savedCursors: readonly { readonly hostId: string; readonly sessionId: string; readonly cursor: Cursor }[];
      readonly capabilities?: readonly string[];
      readonly authentication?: { readonly deviceId: string; readonly deviceToken: string };
    }
  | {
      readonly kind: "command";
      readonly requestId: string;
      readonly commandId: string;
      readonly hostId: string;
      readonly sessionId?: string;
      readonly command: string;
      readonly expectedRevision?: string;
      readonly confirmationId?: string;
      readonly args?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "confirm";
      readonly requestId: string;
      readonly confirmationId: string;
      readonly commandId: string;
      readonly hostId: string;
      readonly sessionId?: string;
      readonly decision: "approve" | "deny";
    }
  | {
      readonly kind: "pair-start";
      readonly requestId: string;
      readonly code: string;
      readonly deviceId: string;
      readonly deviceName: string;
      readonly platform: string;
      readonly requestedCapabilities: readonly string[];
    }
  | {
      readonly kind: "terminal-input";
      readonly hostId: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly data: string;
      readonly encoding?: "utf8" | "base64";
    }
  | {
      readonly kind: "terminal-resize";
      readonly hostId: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly kind: "terminal-close";
      readonly hostId: string;
      readonly sessionId: string;
      readonly terminalId: string;
      readonly reason?: string;
    }
  | { readonly kind: "ping"; readonly nonce: string; readonly timestamp: string };

type KnownFields<Value> = {
  [Key in keyof Value as string extends Key
    ? never
    : number extends Key
      ? never
      : symbol extends Key
        ? never
        : Key]: Value[Key];
};

type PreservedIndex<Value> = string extends keyof Value ? Readonly<Record<string, unknown>> : object;

type OmpServerEventPayload<Frame extends ServerFrame> = Readonly<
  Omit<KnownFields<Frame>, "v" | "type"> & PreservedIndex<Frame>
>;

type OmpServerEventFromFrame<Frame extends ServerFrame> = Frame extends ServerFrame
  ? Readonly<{
      kind: Frame["type"];
      payload: OmpServerEventPayload<Frame>;
    }>
  : never;

type OmpDecodedServerEventFromFrame<Frame extends ServerFrame> = Frame extends ServerFrame
  ? Readonly<{
      kind: Frame["type"];
      payload: OmpServerEventPayload<Frame>;
      event: OmpServerEventFromFrame<Frame>;
      wireFrame: Frame;
    }>
  : never;

/** Stable, version-free event shape exposed to new T4 consumers. */
export type OmpServerEvent = OmpServerEventFromFrame<ServerFrame>;

/** Decoded provider result used while the legacy onFrame API is supported. */
export type OmpDecodedServerEvent = OmpDecodedServerEventFromFrame<ServerFrame>;

/** Pairing credentials never cross the public event subscription boundary. */
export type PublicOmpServerEvent = Exclude<OmpServerEvent, { kind: "pair.ok" }>;

/**
 * The narrow protocol seam consumed by OmpClient. Transport, reconnect, replay,
 * and projection logic stay independent from a concrete wire implementation.
 */
export interface OmpProtocolProvider {
  readonly id: string;
  readonly protocolVersion: string;
  buildClientFrame(message: OmpClientMessage): ClientFrame;
  encodeClientFrame(frame: ClientFrame): string;
  decodeServerEvent(input: unknown): OmpDecodedServerEvent;
  commandDescriptor(command: string): CommandDescriptor | undefined;
  requiredCapability(command: string): DeviceCapability | undefined;
}
