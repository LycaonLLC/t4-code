import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRunner, ProcessSpec } from "@t4-code/remote";
import {
  createSafeServiceEnvironment,
  discoverOmpExecutable,
  discoverT4HostExecutable,
  NodeServiceRunner,
  OmpAppserverCompatibilityError,
  probeOmpAppserver,
} from "../src/service.ts";

describe("desktop lifecycle boundaries", () => {
  it("discovers only an executable standalone T4 host path", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-host-discovery-"));
    const executable = join(root, "t4-host");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    expect(
      await discoverT4HostExecutable({
        environment: { T4_HOST_EXECUTABLE: executable, PATH: "" },
        homeDirectory: root,
      }),
    ).toBe(executable);
    expect(
      await discoverT4HostExecutable({
        environment: { T4_HOST_EXECUTABLE: join(root, "wrong-name"), PATH: "" },
        homeDirectory: root,
      }),
    ).toBeUndefined();
  });
  it("only discovers bounded executable candidates and honors explicit environment", async () => {
    const executable = await discoverOmpExecutable({
      environment: { OMP_EXECUTABLE: "/not/a/real/omp", PATH: "" },
      homeDirectory: "/not/a/home",
    });
    expect(executable).toBe(undefined);
  });
  it("uses explicit executable before PATH and ignores renderer URL as a service candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const explicitDir = join(root, "explicit");
    const pathDir = join(root, "path");
    await mkdir(explicitDir);
    await mkdir(pathDir);
    const explicit = join(explicitDir, "omp");
    const pathCandidate = join(pathDir, "omp");
    await writeFile(explicit, "");
    await writeFile(pathCandidate, "");
    await chmod(explicit, 0o755);
    await chmod(pathCandidate, 0o755);
    const probeRunner: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ state: "stopped", reason: "unreachable" }),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: {
          OMP_EXECUTABLE: explicit,
          PATH: pathDir,
          OMP_DESKTOP_RENDERER_URL: "http://127.0.0.1:5173/",
        },
        homeDirectory: root,
        runner: probeRunner,
      }),
    ).toBe(explicit);
    expect(
      await discoverOmpExecutable({
        environment: { PATH: "", OMP_DESKTOP_RENDERER_URL: explicit },
        homeDirectory: root,
        runner: probeRunner,
      }),
    ).toBeUndefined();
  });
  it("rejects an executable that does not implement appserver status", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const runner: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "normal agent help",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner,
      }),
    ).toBeUndefined();
  });
  it("reports old OMP builds that reject the required JSON status flag", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls += 1;
        expect(spec.args).toEqual(["appserver", "status", "--json"]);
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 2,
            signal: null,
            stdout: "",
            stderr: "Error: unknown flag: --json\nRun omp --help for usage.\n",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };
    const error = await discoverOmpExecutable({
      environment: { OMP_EXECUTABLE: executable, PATH: "" },
      homeDirectory: root,
      runner,
    }).catch((cause: unknown) => cause);
    expect(error instanceof OmpAppserverCompatibilityError).toBe(true);
    if (!(error instanceof OmpAppserverCompatibilityError))
      throw new Error("expected compatibility error");
    expect(error.code).toBe("omp_appserver_status_json_required");
    expect(error.message.includes("requires `omp appserver status --json`")).toBe(true);
    expect(calls).toBe(1);
  });
  it("scopes named appserver probes without inheriting provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              state: "running",
              health: { ok: true, hostId: "host-fable", epoch: "epoch-fable" },
            }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };

    expect(
      await probeOmpAppserver(executable, {
        profileId: "fable-swarm",
        environment: {
          HOME: "/home/test",
          PATH: "/usr/bin:/bin",
          ANTHROPIC_API_KEY: "must-not-inherit",
        },
        runner,
      }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["appserver", "status", "--json"]);
    expect(calls[0]?.env).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      OMP_PROFILE: "fable-swarm",
    });
  });
  it("rejects malformed, oversized, and timed-out appserver probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const malformed: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "{",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner: malformed,
      }),
    ).toBeUndefined();
    const oversized: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "x".repeat(17 * 1024),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner: oversized,
      }),
    ).toBeUndefined();
    const timedOut: ProcessRunner = {
      spawn: async (_spec, signal) => {
        const result = Promise.withResolvers<{
          exitCode: number | null;
          signal: null;
          stdout: string;
          stderr: string;
          stdoutTruncated: boolean;
          stderrTruncated: boolean;
        }>();
        signal?.addEventListener(
          "abort",
          () =>
            result.resolve({
              exitCode: null,
              signal: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
          { once: true },
        );
        return { kill: () => {}, result: result.promise };
      },
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner: timedOut,
        timeoutMs: 10,
      }),
    ).toBeUndefined();
  });
  it("does not execute ompd candidates that have no status CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "ompd");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async () => {
        calls += 1;
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "{}",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable },
        homeDirectory: root,
        runner,
      }),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });
  it("passes only desktop service environment keys and keeps argv shell-free", async () => {
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        return {
          kill: () => {},
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        };
      },
    };
    const environment = {
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      TMPDIR: "/tmp/test",
      OMP_TOKEN: "secret",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
      PROVIDER_API_KEY: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      UNRELATED: "discard",
    };

    await new NodeServiceRunner({ environment, runner }).run([
      "systemctl",
      "--user",
      "start",
      "t4-code.service",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "systemctl",
      args: ["--user", "start", "t4-code.service"],
    });
    expect(calls[0]?.env).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      TMPDIR: "/tmp/test",
    });
    expect("shell" in (calls[0] ?? {})).toBe(false);
    expect(calls[0]?.args?.join(" ")).not.toContain("|");
    expect(calls[0]?.args?.join(" ")).not.toContain(";");
  });

  it("omits absent service environment values", () => {
    expect(
      createSafeServiceEnvironment({
        HOME: "/home/test",
        PATH: undefined,
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: undefined,
        TMPDIR: "",
        OMP_PASSWORD: "secret",
      }),
    ).toEqual({
      HOME: "/home/test",
      XDG_RUNTIME_DIR: "/run/user/1000",
      TMPDIR: "",
    });
  });
});
