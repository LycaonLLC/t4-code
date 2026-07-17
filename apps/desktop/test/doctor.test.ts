import { describe, expect, it } from "vitest";

import {
  collectDoctorReport,
  formatDoctorReport,
  satisfiesCaretVersion,
  type DoctorRuntime,
  type SourceContract,
} from "../src/doctor.ts";
import { OmpAppserverCompatibilityError } from "../src/service.ts";

const contract: SourceContract = {
  nodeEngine: "^24.13.1",
  pnpmVersion: "11.10.0",
  ompVersion: "17.0.0",
  ompTag: "t4code-17.0.0-appserver-6",
  ompUrl: "https://example.test/verified-omp",
};

function runtime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
  return {
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.17.0",
    sourceContract: async () => contract,
    pnpmVersion: async () => "11.10.0",
    discoverOmp: async () => "/opt/omp/bin/omp",
    probeOmp: async () => true,
    profileCount: async () => 3,
    inspectTailnet: async () => "ready",
    ...overrides,
  };
}

describe("T4 setup doctor", () => {
  it("accepts the checked-in toolchain and a healthy local runtime", async () => {
    const report = await collectDoctorReport(runtime());

    expect(report.ok).toBe(true);
    expect(report.checks.map((item) => [item.id, item.status])).toEqual([
      ["platform", "pass"],
      ["node", "pass"],
      ["pnpm", "pass"],
      ["omp", "pass"],
      ["appserver", "pass"],
      ["profiles", "pass"],
      ["tailscale", "pass"],
    ]);
    expect(formatDoctorReport(report)).toContain("Required setup checks passed.");
  });

  it("explains incompatible tools without exposing executable paths or raw errors", async () => {
    const report = await collectDoctorReport(
      runtime({
        nodeVersion: "25.2.1",
        pnpmVersion: async () => "10.0.0",
        discoverOmp: async () => {
          throw new OmpAppserverCompatibilityError();
        },
        profileCount: async () => {
          throw new Error("/private/example/.omp contains REDACT_ME");
        },
        inspectTailnet: async () => "unavailable",
      }),
    );
    const rendered = formatDoctorReport(report);

    expect(report.ok).toBe(false);
    expect(report.checks.filter((item) => item.status === "fail").map((item) => item.id)).toEqual([
      "node",
      "pnpm",
      "omp",
    ]);
    expect(rendered).toContain("does not provide the appserver status contract");
    expect(rendered).toContain(contract.ompTag);
    expect(rendered).not.toContain("/private/example");
    expect(rendered).not.toContain("REDACT_ME");
  });

  it("treats an optional stopped appserver and missing Tailscale as warnings", async () => {
    const report = await collectDoctorReport(
      runtime({ probeOmp: async () => false, inspectTailnet: async () => "not-installed" }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((item) => item.id === "appserver")?.status).toBe("warning");
    expect(report.checks.find((item) => item.id === "tailscale")?.status).toBe("warning");
  });

  it("keeps mobile targets out of unsupported desktop guidance", async () => {
    const report = await collectDoctorReport(runtime({ arch: "x64" }));
    const platform = report.checks.find((item) => item.id === "platform");

    expect(platform?.status).toBe("warning");
    expect(platform?.action).toBe(
      "Use Linux x86-64 or Apple Silicon macOS for a supported packaged desktop build.",
    );
    expect(platform?.action).not.toContain("Android");
  });

  it("implements the caret range used by the repository", () => {
    expect(satisfiesCaretVersion("24.13.1", "^24.13.1")).toBe(true);
    expect(satisfiesCaretVersion("24.17.0", "^24.13.1")).toBe(true);
    expect(satisfiesCaretVersion("24.12.9", "^24.13.1")).toBe(false);
    expect(satisfiesCaretVersion("25.0.0", "^24.13.1")).toBe(false);
    expect(satisfiesCaretVersion("not-a-version", "^24.13.1")).toBe(false);
  });
});
