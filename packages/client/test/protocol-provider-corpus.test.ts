import { describe, expect, it } from "vite-plus/test";

import { ompAppV1ProtocolProvider } from "../src/index.ts";
import {
  decodeProtocolProviderCorpus,
  loadProtocolProviderCorpus,
  protocolProviderCorpus,
} from "./protocol-provider-corpus.ts";

const corpus = loadProtocolProviderCorpus(
  new URL("./fixtures/protocol/omp-app-v1-corpus.json", import.meta.url),
);

protocolProviderCorpus({ provider: ompAppV1ProtocolProvider, corpus });

describe("protocol provider corpus schema", () => {
  it("rejects an unknown corpus schema before running provider tests", () => {
    expect(() => decodeProtocolProviderCorpus({ schemaVersion: 2 })).toThrow(
      "unsupported protocol corpus schema",
    );
  });

  it("rejects an incomplete corpus before it can hide missing coverage", () => {
    expect(() =>
      decodeProtocolProviderCorpus({
        schemaVersion: 1,
        provider: { id: "omp-app-v1", protocolVersion: "omp-app/1" },
        outbound: [],
        inbound: [],
        invalidInbound: [],
      }),
    ).toThrow("protocol corpus outbound must be a non-empty array");
  });

  it("rejects unknown logical messages and malformed normalized events", () => {
    const base = {
      schemaVersion: 1,
      provider: { id: "omp-app-v1", protocolVersion: "omp-app/1" },
      invalidInbound: [{ name: "invalid", wire: null }],
    };
    expect(() =>
      decodeProtocolProviderCorpus({
        ...base,
        outbound: [{ name: "future", message: { kind: "future" }, wire: {} }],
        inbound: [{ name: "welcome", wire: {}, event: { kind: "welcome", payload: {} } }],
      }),
    ).toThrow("unknown protocol corpus outbound kind");
    expect(() =>
      decodeProtocolProviderCorpus({
        ...base,
        outbound: [{ name: "ping", message: { kind: "ping" }, wire: {} }],
        inbound: [{ name: "missing-kind", wire: {}, event: { kind: "", payload: {} } }],
      }),
    ).toThrow("event.kind must be a non-empty string");
  });
});
