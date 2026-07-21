import { describe, expect, test } from "bun:test";
import { hostDaemonPaths, parseHostDaemonArgs, runHostDaemon } from "../src/cli.ts";

describe("T4 host daemon CLI", () => {
  test("parses a local direct-replacement service without ambient executable lookup", () => {
    const config = parseHostDaemonArgs(
      ["serve", "--omp", "/opt/t4/runtime/omp", "--profile", "default"],
      "/home/test",
    );
    expect(config).toEqual({
      ompExecutable: "/opt/t4/runtime/omp",
      authorityMode: "bridge",
      profileId: "default",
      stateRoot: "/home/test/.t4-code/host",
    });
    expect(hostDaemonPaths(config)).toMatchObject({
      profileStateRoot: expect.stringContaining("/home/test/.t4-code/host/profiles/"),
      hostIdPath: expect.stringContaining("/host-id"),
      transcriptSearchPath: expect.stringContaining("/transcript-search.sqlite"),
    });
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
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--omp-authority", "official"],
        "/home/test",
      ),
    ).toThrow("--omp-sessions-root");
    expect(
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--omp-authority",
          "official",
          "--omp-sessions-root",
          "/home/test/.omp/t4/sessions",
          "--profile",
          "t4",
        ],
        "/home/test",
      ),
    ).toMatchObject({
      authorityMode: "official",
      ompSessionsRoot: "/home/test/.omp/t4/sessions",
      profileId: "t4",
    });
  });

  test("stops the OMP bridge when authority startup fails", async () => {
    let bridgeStops = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({ hostInfo: async () => { throw new Error("host info failed"); } }),
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        { createBridge: () => bridge as never },
      ),
    ).rejects.toThrow("host info failed");
    expect(bridgeStops).toBe(1);
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
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        {
          createBridge: () => bridge as never,
          createTranscriptSearch: () => ({ close: async () => { searchCloses += 1; } }) as never,
          createLocal: () => { throw new Error("appserver construction failed"); },
        },
      ),
    ).rejects.toThrow("appserver construction failed");
    expect(searchCloses).toBe(1);
    expect(bridgeStops).toBe(1);
  });
});
