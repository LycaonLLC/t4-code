import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRunner, ProcessSpec } from "@t4-code/remote";
import {
  createSafeServiceEnvironment,
  discoverOmpExecutable,
  discoverT4HostExecutable,
  inspectPathOmpCompatibility,
  NodeServiceRunner,
  OFFICIAL_OMP_VERSION,
  OmpRuntimeCompatibilityError,
  probeOmpRuntime,
  repairAppserverService,
} from "../src/service.ts";
import type { ServiceManager } from "@t4-code/service-manager";

const officialVersionResult = {
  exitCode: 0,
  signal: null,
  stdout: `omp/${OFFICIAL_OMP_VERSION}\n`,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
} as const;

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

  it("uses an exact official OMP runtime before PATH and ignores renderer URLs", async () => {
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
    const runner: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve(officialVersionResult),
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
        runner,
      }),
    ).toBe(explicit);
    expect(
      await discoverOmpExecutable({
        environment: { PATH: "", OMP_DESKTOP_RENDERER_URL: explicit },
        homeDirectory: root,
        runner,
      }),
    ).toBeUndefined();
  });

  it("reports a different official OMP version as incompatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls += 1;
        expect(spec.args).toEqual(["--version"]);
        return {
          kill: () => {},
          result: Promise.resolve({ ...officialVersionResult, stdout: "omp/18.0.10\n" }),
        };
      },
    };

    const error = await discoverOmpExecutable({
      environment: { OMP_EXECUTABLE: executable, PATH: "" },
      homeDirectory: root,
      runner,
    }).catch((cause: unknown) => cause);
    expect(error instanceof OmpRuntimeCompatibilityError).toBe(true);
    if (!(error instanceof OmpRuntimeCompatibilityError))
      throw new Error("expected compatibility error");
    expect(error.code).toBe("omp_official_runtime_required");
    expect(error.message).toContain(`requires unmodified official OMP ${OFFICIAL_OMP_VERSION}`);
    expect(calls).toBe(1);
  });

  it("detects mixed PATH versions instead of blessing only the first runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const oldDir = join(root, "old");
    const currentDir = join(root, "current");
    await mkdir(oldDir);
    await mkdir(currentDir);
    await writeFile(join(oldDir, "omp"), "");
    await writeFile(join(currentDir, "omp"), "");
    await chmod(join(oldDir, "omp"), 0o755);
    await chmod(join(currentDir, "omp"), 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls += 1;
        return {
          kill: () => {},
          result: Promise.resolve(
            spec.command === join(currentDir, "omp")
              ? officialVersionResult
              : { ...officialVersionResult, stdout: "omp/18.0.10\n" },
          ),
        };
      },
    };

    expect(
      await inspectPathOmpCompatibility({
        environment: { PATH: `${oldDir}:${currentDir}` },
        runner,
      }),
    ).toBe("mixed");
    expect(calls).toBe(2);
  });

  it("probes the runtime without inheriting provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        return { kill: () => {}, result: Promise.resolve(officialVersionResult) };
      },
    };

    expect(
      await probeOmpRuntime(executable, {
        environment: {
          HOME: "/home/test",
          PATH: "/usr/bin:/bin",
          ANTHROPIC_API_KEY: "must-not-inherit",
        },
        runner,
      }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["--version"]);
    expect(calls[0]?.env).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
    });
  });

  it("rejects malformed, oversized, and timed-out runtime probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    const malformed: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve({ ...officialVersionResult, stdout: "not-omp" }),
      }),
    };
    await expect(
      discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable, PATH: "" },
        homeDirectory: root,
        runner: malformed,
      }),
    ).rejects.toThrow(OmpRuntimeCompatibilityError);

    const oversized: ProcessRunner = {
      spawn: async () => ({
        kill: () => {},
        result: Promise.resolve({ ...officialVersionResult, stdout: "x".repeat(5 * 1024) }),
      }),
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable, PATH: "" },
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
        environment: { OMP_EXECUTABLE: executable, PATH: "" },
        homeDirectory: root,
        runner: timedOut,
        timeoutMs: 10,
      }),
    ).toBeUndefined();
  });

  it("does not execute similarly named non-OMP candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-desktop-"));
    const executable = join(root, "ompd");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let calls = 0;
    const runner: ProcessRunner = {
      spawn: async () => {
        calls += 1;
        return { kill: () => {}, result: Promise.resolve(officialVersionResult) };
      },
    };
    expect(
      await discoverOmpExecutable({
        environment: { OMP_EXECUTABLE: executable, PATH: "" },
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

  it("repairs a current but unregistered appserver after one transient start failure", async () => {
    const calls: string[] = [];
    let running = false;
    const manager: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        return {
          definition: "current",
          service: running ? "running" : "stopped",
          diagnostics: "",
        };
      },
      install: async () => {
        calls.push("install");
        running = true;
      },
      start: async () => {
        calls.push("start");
        throw new Error("launchd was still removing the old registration");
      },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };

    await repairAppserverService(manager, { delay: async () => {} });

    expect(calls).toEqual(["inspect", "start", "inspect", "install", "inspect"]);
  });

  it("does not rewrite a healthy appserver service", async () => {
    const calls: string[] = [];
    const manager: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        return { definition: "current", service: "running", diagnostics: "ready" };
      },
      install: async () => { calls.push("install"); },
      start: async () => { calls.push("start"); },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };

    await repairAppserverService(manager, { delay: async () => {} });

    expect(calls).toEqual(["inspect"]);
  });

  it("lets an appserver that is already starting finish without restarting it", async () => {
    const calls: string[] = [];
    const manager: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        return { definition: "current", service: "starting", diagnostics: "launching" };
      },
      install: async () => { calls.push("install"); },
      start: async () => { calls.push("start"); },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };

    await repairAppserverService(manager, { delay: async () => {} });

    expect(calls).toEqual(["inspect"]);
  });
});
