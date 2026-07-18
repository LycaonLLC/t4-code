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

/**
 * The narrow protocol seam consumed by OmpClient. Transport, reconnect, replay,
 * and projection logic stay independent from a concrete wire implementation.
 */
export interface OmpProtocolProvider {
  readonly id: string;
  readonly protocolVersion: string;
  buildClientFrame(message: OmpClientMessage): ClientFrame;
  encodeClientFrame(frame: ClientFrame): string;
  decodeClientFrame(input: unknown): ClientFrame;
  decodeServerFrame(input: unknown): ServerFrame;
  commandDescriptor(command: string): CommandDescriptor | undefined;
  requiredCapability(command: string): DeviceCapability | undefined;
}
