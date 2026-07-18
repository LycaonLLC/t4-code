import { describe, expect, it } from "vite-plus/test";

import type {
  OmpClientMessage,
  OmpProtocolProvider,
} from "../src/index.ts";
import type { DeviceCapability } from "@t4-code/protocol";

const OUTBOUND_KINDS = {
  hello: true,
  command: true,
  confirm: true,
  "pair-start": true,
  "terminal-input": true,
  "terminal-resize": true,
  "terminal-close": true,
  ping: true,
} as const satisfies Record<OmpClientMessage["kind"], true>;

export interface ProtocolProviderConformanceOptions {
  readonly name: string;
  readonly provider: OmpProtocolProvider;
  readonly outboundMessages: readonly OmpClientMessage[];
  readonly inboundFrames: readonly unknown[];
  readonly invalidInbound: readonly unknown[];
  readonly knownCommand: {
    readonly name: string;
    readonly capability: DeviceCapability;
  };
}

/** Common behavioral contract every concrete OMP protocol provider must satisfy. */
export function protocolProviderConformance(
  options: ProtocolProviderConformanceOptions,
): void {
  describe(`${options.name} provider conformance`, () => {
    it("builds and encodes every declared outbound message", () => {
      expect(options.outboundMessages.length).toBeGreaterThan(0);
      expect(new Set(options.outboundMessages.map((message) => message.kind))).toEqual(
        new Set(Object.keys(OUTBOUND_KINDS)),
      );
      for (const message of options.outboundMessages) {
        const frame = options.provider.buildClientFrame(message);
        const encoded = options.provider.encodeClientFrame(frame);
        expect(typeof encoded).toBe("string");
        expect(encoded.length).toBeGreaterThan(0);
      }
    });

    it("normalizes validated inbound frames into one immutable event shape", () => {
      expect(options.inboundFrames.length).toBeGreaterThan(0);
      for (const input of options.inboundFrames) {
        const decoded = options.provider.decodeServerEvent(input);
        expect(decoded.kind).toBe(decoded.event.kind);
        expect(decoded.payload).toBe(decoded.event.payload);
        expect(decoded.payload).not.toHaveProperty("v");
        expect(decoded.payload).not.toHaveProperty("type");
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.event)).toBe(true);
        expect(Object.isFrozen(decoded.payload)).toBe(true);
      }
    });

    it("rejects malformed inbound values", () => {
      expect(options.invalidInbound.length).toBeGreaterThan(0);
      for (const input of options.invalidInbound) {
        expect(() => options.provider.decodeServerEvent(input)).toThrow();
      }
    });

    it("agrees on command descriptors and capability lookup", () => {
      expect(options.provider.commandDescriptor(options.knownCommand.name)?.capability).toBe(
        options.knownCommand.capability,
      );
      expect(options.provider.requiredCapability(options.knownCommand.name)).toBe(
        options.knownCommand.capability,
      );
    });
  });
}
