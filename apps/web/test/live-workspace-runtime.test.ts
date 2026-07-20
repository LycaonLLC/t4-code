import {
  OMP_RUNTIME_INTEGRATION,
  createProjectionSnapshot,
  type DesktopRuntimeSnapshot,
} from "@t4-code/client";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";

describe("live workspace runtime identity", () => {
  it("carries the owning OMP integration into the UI host model", () => {
    const snapshot: DesktopRuntimeSnapshot = {
      version: 1,
      integration: OMP_RUNTIME_INTEGRATION,
      platform: "darwin",
      desktopVersion: "test",
      startState: "started",
      targets: new Map([
        [
          "local",
          {
            targetId: "local",
            label: "This machine",
            kind: "local",
            state: "connected",
            paired: true,
          },
        ],
      ]),
      connections: new Map([["local", "connected"]]),
      targetHosts: new Map([["local", "host-local"]]),
      hosts: new Map([
        [
          "host-local",
          {
            targetId: "local",
            hostId: "host-local",
            ompVersion: "test",
            ompBuild: "test",
            appserverVersion: "test",
            appserverBuild: "test",
            epoch: "epoch-1",
            grantedCapabilities: [],
            grantedFeatures: [],
            negotiatedLimits: {},
            authentication: "local",
            resumed: false,
          },
        ],
      ]),
      catalogs: new Map(),
      settings: new Map(),
      projection: createProjectionSnapshot(),
      runtimeErrors: [],
    };

    expect(deriveWorkspaceData(snapshot).hosts).toEqual([
      expect.objectContaining({ id: "host-local", runtimeKind: "omp" }),
    ]);
  });
});
