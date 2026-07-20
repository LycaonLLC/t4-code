import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostDaemonPaths,
  parseHostDaemonArgs,
  runHostDaemon,
  standardOmpSessionRoot,
} from "../src/cli.ts";

describe("T4 host daemon CLI", () => {
  test("parses a local direct-replacement service without ambient executable lookup", () => {
    const config = parseHostDaemonArgs(
      ["serve", "--omp", "/opt/t4/runtime/omp", "--profile", "default"],
      "/home/test",
    );
    expect(config).toEqual({
      ompExecutable: "/opt/t4/runtime/omp",
      profileId: "default",
      sessionRoot: "/home/test/.omp/agent/sessions",
      stateRoot: "/home/test/.t4-code/host",
    });
    expect(hostDaemonPaths(config)).toMatchObject({
      profileStateRoot: expect.stringContaining("/home/test/.t4-code/host/profiles/"),
      hostIdPath: expect.stringContaining("/host-id"),
      transcriptSearchPath: expect.stringContaining("/transcript-search.sqlite"),
    });
  });

  test("resolves standard OMP default and named-profile session roots", () => {
    expect(standardOmpSessionRoot("default", "/home/test")).toBe("/home/test/.omp/agent/sessions");
    expect(standardOmpSessionRoot("fable-swarm", "/home/test")).toBe(
      "/home/test/.omp/profiles/fable-swarm/agent/sessions",
    );
    expect(
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--session-root", "/data/custom-omp-sessions"],
        "/home/test",
      ).sessionRoot,
    ).toBe("/data/custom-omp-sessions");
  });

  test("validates remote exposure and rejects ambiguous or relative authority", () => {
    expect(() => parseHostDaemonArgs(["serve", "--omp", "omp"], "/home/test")).toThrow("absolute");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--remote-address", "100.64.0.1"],
        "/home/test",
      ),
    ).toThrow("require --remote-mode");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--remote-mode", "serve", "--remote-address", "0.0.0.0"],
        "/home/test",
      ),
    ).toThrow("loopback");
    expect(() =>
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--remote-mode",
          "direct",
          "--remote-address",
          "100.64.0.1",
          "--remote-origin",
          "https://example.com/path",
        ],
        "/home/test",
      ),
    ).toThrow("HTTP origin");
  });

  test("falls back to an explicit read-only file host when the OMP bridge is unavailable", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "t4-host-compat-"));
    let bridgeStops = 0;
    let compatibilityReports = 0;
    let daemonStops = 0;
    let stopRequested: (() => void) | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    let discoveryRoot: string | undefined;
    const bridge = {
      start: async () => {
        throw new Error("unknown command bridge");
      },
      stop: async () => {
        if (bridgeStops === 0) bridgeStops += 1;
      },
    };
    try {
      await runHostDaemon(
        {
          ompExecutable: "/opt/omp",
          profileId: "test",
          sessionRoot: "/home/test/.omp/profiles/test/agent/sessions",
          stateRoot,
        },
        {
          createBridge: () => bridge as never,
          createCompatibilityDiscovery: (root) => {
            discoveryRoot = root;
            return { list: async () => [] };
          },
          createTranscriptSearch: () => ({ close: async () => {} }) as never,
          createLocal: (options) => {
            capturedOptions = options as unknown as Record<string, unknown>;
            return {
              start: async () => {
                stopRequested?.();
              },
              stop: async () => {
                daemonStops += 1;
              },
            } as never;
          },
          onSignal: (_signal, listener) => {
            stopRequested = listener;
          },
          removeSignal: () => {},
          reportCompatibility: () => {
            compatibilityReports += 1;
          },
        },
      );
      expect(discoveryRoot).toBe("/home/test/.omp/profiles/test/agent/sessions");
      expect(capturedOptions).toMatchObject({
        ompVersion: "standard",
        ompBuild: "filesystem-read-only",
        readOnlyCompatibility: true,
        discoveryPollMs: 1_000,
        supportedCapabilities: ["sessions.read"],
        supportedFeatures: ["resume", "session.observer", "transcript.page", "transcript.search"],
      });
      expect(compatibilityReports).toBe(1);
      expect(daemonStops).toBe(1);
    expect(bridgeStops).toBe(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("closes the search index when appserver construction fails", async () => {
    let bridgeStops = 0;
    let searchCloses = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({ transcriptImageRoot: "/tmp/images" }),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {},
        projectRootForProject: async () => "/tmp",
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => {
        bridgeStops += 1;
      },
    };
    await expect(
      runHostDaemon(
        {
          ompExecutable: "/opt/omp",
          profileId: "test",
          sessionRoot: "/tmp/omp-sessions",
          stateRoot: "/tmp/t4-host-test",
        },
        {
          createBridge: () => bridge as never,
          createTranscriptSearch: () =>
            ({
              close: async () => {
                searchCloses += 1;
              },
            }) as never,
          createLocal: () => {
            throw new Error("appserver construction failed");
          },
        },
      ),
    ).rejects.toThrow("appserver construction failed");
    expect(searchCloses).toBe(1);
    expect(bridgeStops).toBe(1);
  });
});
