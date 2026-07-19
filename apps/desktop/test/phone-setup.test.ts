import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessRunner, ProcessSpec } from "@t4-code/remote";
import { PhoneSetupService } from "../src/phone-setup.ts";

describe("phone setup", () => {
  it("turns a connected Mac tailnet into a private QR destination", async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), "t4-phone-setup-"));
    await mkdir(join(resourcesPath, "runtime"));
    await writeFile(join(resourcesPath, "runtime", "manifest.json"), '{"tag":"synthetic"}\n');
    const calls: ProcessSpec[] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        calls.push(spec);
        const isStatus = spec.command === "/tailscale" && spec.args?.[0] === "status";
        const isGatewayInspect = spec.command === "/Applications/T4 Code.app/Contents/MacOS/T4 Code" && spec.args?.[1] === "status";
        return {
          kill: () => {},
          result: Promise.resolve(isStatus
            ? { exitCode: 0, signal: null, stdout: JSON.stringify({ Self: { DNSName: "work-mac.example.ts.net." } }), stderr: "", stdoutTruncated: false, stderrTruncated: false }
            : isGatewayInspect
              ? { exitCode: 1, signal: null, stdout: "", stderr: "not installed", stdoutTruncated: false, stderrTruncated: false }
              : { exitCode: 0, signal: null, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
        };
      },
    };
    const service = new PhoneSetupService({
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      electronExecutable: "/Applications/T4 Code.app/Contents/MacOS/T4 Code",
      runner,
      discoverTailscale: async () => "/tailscale",
    });

    expect(await service.inspect()).toEqual({
      phase: "not-configured",
      message: "Set up private phone access, then scan the QR code with your phone.",
      url: "https://work-mac.example.ts.net:8445/",
    });
    expect(await service.configure()).toMatchObject({
      phase: "ready",
      url: "https://work-mac.example.ts.net:8445/",
    });
    const serve = calls.find((call) => call.command === "/tailscale" && call.args?.[0] === "serve");
    expect(serve?.args).toEqual(["serve", "--bg", "--https=8445", "http://127.0.0.1:4194"]);
    expect(JSON.stringify(calls)).not.toContain("funnel");
    const install = calls.find((call) => call.command.includes("T4 Code") && call.args?.includes("install"));
    expect(install?.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" });
    expect(install?.args).toContain("--electron-run-as-node");
  });
});
