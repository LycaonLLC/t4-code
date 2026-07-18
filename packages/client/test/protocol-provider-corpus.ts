import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import type {
  OmpClientMessage,
  OmpProtocolProvider,
  OmpServerEvent,
} from "../src/index.ts";

const OUTBOUND_KINDS = [
  "hello",
  "command",
  "confirm",
  "pair-start",
  "terminal-input",
  "terminal-resize",
  "terminal-close",
  "ping",
] as const satisfies readonly OmpClientMessage["kind"][];

const REPRESENTATIVE_INBOUND_KINDS = [
  "welcome",
  "response",
  "error",
  "sessions",
  "snapshot",
  "event",
  "confirmation",
  "terminal.output",
  "gap",
  "pong",
  "pair.ok",
] as const satisfies readonly OmpServerEvent["kind"][];

interface ProtocolCorpusCase {
  readonly name: string;
}

interface ProtocolCorpusOutboundCase extends ProtocolCorpusCase {
  readonly message: OmpClientMessage;
  readonly wire: Readonly<Record<string, unknown>>;
}

interface ProtocolCorpusInboundCase extends ProtocolCorpusCase {
  readonly wire: Readonly<Record<string, unknown>>;
  readonly event: OmpServerEvent;
}

interface ProtocolCorpusInvalidCase extends ProtocolCorpusCase {
  readonly wire: unknown;
}

export interface ProtocolProviderCorpus {
  readonly schemaVersion: 1;
  readonly provider: {
    readonly id: string;
    readonly protocolVersion: string;
  };
  readonly outbound: readonly ProtocolCorpusOutboundCase[];
  readonly inbound: readonly ProtocolCorpusInboundCase[];
  readonly invalidInbound: readonly ProtocolCorpusInvalidCase[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function cases(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

export function decodeProtocolProviderCorpus(input: unknown): ProtocolProviderCorpus {
  const corpus = record(input, "protocol corpus");
  if (corpus.schemaVersion !== 1) throw new Error("unsupported protocol corpus schema");
  const provider = record(corpus.provider, "protocol corpus provider");
  const outbound = cases(corpus.outbound, "protocol corpus outbound").map((entry, index) => {
    const message = record(entry.message, `protocol corpus outbound[${index}].message`);
    if (!OUTBOUND_KINDS.includes(message.kind as OmpClientMessage["kind"])) {
      throw new Error(`unknown protocol corpus outbound kind: ${String(message.kind)}`);
    }
    return Object.freeze({
      name: nonEmptyString(entry.name, `protocol corpus outbound[${index}].name`),
      message: message as unknown as OmpClientMessage,
      wire: record(entry.wire, `protocol corpus outbound[${index}].wire`),
    });
  });
  const inbound = cases(corpus.inbound, "protocol corpus inbound").map((entry, index) => {
    const event = record(entry.event, `protocol corpus inbound[${index}].event`);
    nonEmptyString(event.kind, `protocol corpus inbound[${index}].event.kind`);
    record(event.payload, `protocol corpus inbound[${index}].event.payload`);
    return Object.freeze({
      name: nonEmptyString(entry.name, `protocol corpus inbound[${index}].name`),
      wire: record(entry.wire, `protocol corpus inbound[${index}].wire`),
      event: event as unknown as OmpServerEvent,
    });
  });
  const invalidInbound = cases(corpus.invalidInbound, "protocol corpus invalidInbound").map(
    (entry, index) =>
      Object.freeze({
        name: nonEmptyString(entry.name, `protocol corpus invalidInbound[${index}].name`),
        wire: entry.wire,
      }),
  );
  return Object.freeze({
    schemaVersion: 1,
    provider: Object.freeze({
      id: nonEmptyString(provider.id, "protocol corpus provider.id"),
      protocolVersion: nonEmptyString(
        provider.protocolVersion,
        "protocol corpus provider.protocolVersion",
      ),
    }),
    outbound: Object.freeze(outbound),
    inbound: Object.freeze(inbound),
    invalidInbound: Object.freeze(invalidInbound),
  });
}

export function loadProtocolProviderCorpus(url: URL): ProtocolProviderCorpus {
  return decodeProtocolProviderCorpus(JSON.parse(readFileSync(url, "utf8")) as unknown);
}

function uniqueCaseNames(corpus: ProtocolProviderCorpus): string[] {
  return [...corpus.outbound, ...corpus.inbound, ...corpus.invalidInbound].map(
    (entry) => entry.name,
  );
}

/** Exact checked-in wire examples every concrete protocol provider must satisfy. */
export function protocolProviderCorpus(options: {
  readonly provider: OmpProtocolProvider;
  readonly corpus: ProtocolProviderCorpus;
}): void {
  const { provider, corpus } = options;
  describe(`${provider.protocolVersion} golden protocol corpus`, () => {
    it("belongs to the selected provider and has unique case names", () => {
      expect(corpus.provider).toEqual({
        id: provider.id,
        protocolVersion: provider.protocolVersion,
      });
      const names = uniqueCaseNames(corpus);
      expect(new Set(names).size).toBe(names.length);
    });

    it("encodes every logical client message into its exact wire frame", () => {
      expect(new Set(corpus.outbound.map((entry) => entry.message.kind))).toEqual(
        new Set(OUTBOUND_KINDS),
      );
      for (const entry of corpus.outbound) {
        expect(JSON.parse(provider.encodeClientMessage(entry.message))).toEqual(entry.wire);
      }
    });

    it("decodes representative wire frames into exact normalized events", () => {
      expect(new Set(corpus.inbound.map((entry) => entry.event.kind))).toEqual(
        new Set(REPRESENTATIVE_INBOUND_KINDS),
      );
      for (const entry of corpus.inbound) {
        const fromObject = provider.decodeServerEvent(entry.wire);
        const fromText = provider.decodeServerEvent(JSON.stringify(entry.wire));
        expect.soft(fromObject, entry.name).toEqual(entry.event);
        expect.soft(fromText, `${entry.name} from JSON text`).toEqual(entry.event);
        expect(Object.isFrozen(fromObject)).toBe(true);
        expect(Object.isFrozen(fromObject.payload)).toBe(true);
      }
    });

    it("fails closed for every invalid wire example", () => {
      for (const entry of corpus.invalidInbound) {
        expect(() => provider.decodeServerEvent(entry.wire)).toThrow();
      }
    });
  });
}
