import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OMP_SERVER_EVENT_KINDS,
  decodeClientFrame,
} from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

import { ompAppV1ProtocolProvider } from "../src/index.ts";

const protocolEntry = fileURLToPath(import.meta.resolve("@t4-code/protocol"));
const protocolRoot = dirname(dirname(protocolEntry));
const fixtureRoot = join(
  protocolRoot,
  "node_modules",
  "@oh-my-pi",
  "app-wire",
  "fixtures",
  "v1",
);
const fixtureNames = readdirSync(fixtureRoot).filter((name) => name.endsWith(".json")).sort();
const STRUCTURAL_FIXTURES = new Set(["entry.json"]);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as unknown;
}

function isCanonicalClientFrame(input: unknown): boolean {
  try {
    decodeClientFrame(input);
    return true;
  } catch {
    return false;
  }
}

describe("omp-app/1 canonical fixture coverage", () => {
  it("declares every normalized event kind in the pinned contract", () => {
    expect(ompAppV1ProtocolProvider.serverEventKinds).toEqual(OMP_SERVER_EVENT_KINDS);
    expect(ompAppV1ProtocolProvider.serverEventKinds).not.toContain("pair.start");
  });

  it("classifies and validates every fixture shipped by app-wire", () => {
    const serverKinds = new Set<string>();
    let clientFixtures = 0;
    let invalidFixtures = 0;
    let structuralFixtures = 0;

    for (const name of fixtureNames) {
      const input = fixture(name);
      if (name.endsWith(".invalid.json")) {
        invalidFixtures += 1;
        expect(() => ompAppV1ProtocolProvider.decodeServerEvent(input), name).toThrow();
        continue;
      }
      if (STRUCTURAL_FIXTURES.has(name)) {
        structuralFixtures += 1;
        expect(() => ompAppV1ProtocolProvider.decodeServerEvent(input), name).toThrow();
        continue;
      }
      if (isCanonicalClientFrame(input)) {
        clientFixtures += 1;
        expect(() => ompAppV1ProtocolProvider.decodeServerEvent(input), name).toThrow();
        continue;
      }

      const event = ompAppV1ProtocolProvider.decodeServerEvent(input);
      const rawType = (input as { readonly type?: unknown }).type;
      expect(event.kind, name).toBe(rawType);
      expect(ompAppV1ProtocolProvider.serverEventKinds, name).toContain(event.kind);
      expect(event.payload, name).not.toHaveProperty("v");
      expect(event.payload, name).not.toHaveProperty("type");
      expect(Object.isFrozen(event), name).toBe(true);
      expect(Object.isFrozen(event.payload), name).toBe(true);
      serverKinds.add(event.kind);
    }

    expect(serverKinds.size).toBeGreaterThanOrEqual(20);
    expect(clientFixtures).toBeGreaterThanOrEqual(5);
    expect(invalidFixtures).toBeGreaterThanOrEqual(3);
    expect(structuralFixtures).toBe(STRUCTURAL_FIXTURES.size);
  });
});
