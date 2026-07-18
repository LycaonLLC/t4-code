import { catalogId, hostId, revision } from "@t4-code/protocol";

import { describe, expect, it } from "vite-plus/test";

import { catalogExplorerState } from "../src/features/settings/settings-presentation.ts";
const V = "omp-app/1" as const;

const HOST = { hostLabel: "Build Mac", hostId: "host-a" } as const;

describe("host capability explorer", () => {
  it("names waiting, unavailable, and empty host states", () => {
    expect(catalogExplorerState({ host: HOST, phase: "waiting" })).toMatchObject({
      status: "waiting",
      title: "Waiting for host catalog",
    });
    expect(catalogExplorerState({ host: HOST, phase: "unavailable" })).toMatchObject({
      status: "unavailable",
      title: "Host catalog unavailable",
    });
    expect(
      catalogExplorerState({
        host: HOST,
        catalog: { v: V, type: "catalog", hostId: hostId(HOST.hostId), revision: revision("1"), items: [] },
      }),
    ).toMatchObject({
      status: "empty",
      title: "No capability entries published",
      detail: "Build Mac published no capability entries in its catalog.",
    });
  });

  it("groups supported kinds and omits settings, unsafe metadata, and malformed entries", () => {
    const state = catalogExplorerState({
      host: HOST,
      catalog: {
        v: V,
        hostId: hostId(HOST.hostId),
        type: "catalog",
        revision: revision("7"),
        items: [
          {
            id: catalogId("model:claude"),
            kind: "model",
            name: "Claude",
            description: "A hosted model.",
            metadata: {
              provider: "anthropic",
              modelId: "claude",
              contextWindow: 200_000,
              endpoint: "https://user:secret@example.invalid/",
              value: "SUPER_SECRET",
              nested: { hidden: true },
            },
          },
          {
            id: catalogId("tool:search"),
            kind: "tool",
            name: "Search",
            capabilities: ["catalog.read"],
            metadata: { aliases: ["find", "lookup"] },
          },
          { id: catalogId("command:compact"), kind: "command", name: "Compact" },
          { id: catalogId("setting:secret"), kind: "setting", name: "Not a capability" },
          { id: catalogId("agent:review"), kind: "agent", name: "Review", supported: false },
          { id: catalogId("bad"), kind: "provider", name: "bad\u0000name" },
        ],
      },
    });

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready explorer state");
    expect(state.itemCount).toBe(4);
    expect(state.groups.map((group) => group.kind)).toEqual(["command", "tool", "agent", "model"]);
    expect(state.groups[1]?.entries[0]?.metadata).toEqual([
      { key: "capabilities", value: "catalog.read" },
      { key: "aliases", value: "find, lookup" },
    ]);
    expect(state.groups[3]?.entries[0]?.metadata).toEqual([
      { key: "provider", value: "anthropic" },
      { key: "modelId", value: "claude" },
      { key: "contextWindow", value: "200000" },
    ]);
  });
  it("keeps every valid decoded catalog entry beyond the old 128-item display cap", () => {
    const items = Array.from({ length: 184 }, (_, index) => ({
      id: catalogId(`model:fixture-${index}`),
      kind: "model" as const,
      name: `Fixture model ${index}`,
    }));
    const state = catalogExplorerState({
      host: HOST,
      catalog: {
        v: V,
        hostId: hostId(HOST.hostId),
        type: "catalog",
        revision: revision("184"),
        items,
      },
    });

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready explorer state");
    expect(state.itemCount).toBe(184);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.entries).toHaveLength(184);
  });
});
