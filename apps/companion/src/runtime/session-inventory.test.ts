import { createProjectionStore } from "@t4-code/client";
import {
  hostId,
  projectId,
  revision,
  sessionId,
  type SessionRef,
} from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

import { applySessionListInventory } from "./session-inventory";

function session(id: string): SessionRef {
  return {
    hostId: hostId("host-live"),
    sessionId: sessionId(id),
    project: { projectId: projectId("project-t4"), name: "T4 Code" },
    revision: revision(`revision-${id}`),
    title: `Session ${id}`,
    status: "active",
    updatedAt: "2026-07-19T12:00:00.000Z",
  };
}

describe("companion session inventory", () => {
  it("shows the authoritative session.list rows and removes rows missing from the next complete list", () => {
    const projection = createProjectionStore();
    const firstCursor = applySessionListInventory(projection, "host-live", {
      cursor: { epoch: "epoch-live", seq: 3 },
      sessions: [session("one"), session("two")],
      totalCount: 2,
      truncated: false,
    });

    expect(firstCursor).toEqual({ epoch: "epoch-live", seq: 3 });
    expect([...projection.snapshot.sessionIndex.values()].map((item) => item.title)).toEqual([
      "Session one",
      "Session two",
    ]);

    applySessionListInventory(projection, "host-live", {
      cursor: { epoch: "epoch-live", seq: 4 },
      sessions: [session("two")],
      totalCount: 1,
      truncated: false,
    });

    expect([...projection.snapshot.sessionIndex.values()].map((item) => item.title)).toEqual([
      "Session two",
    ]);
  });
});
