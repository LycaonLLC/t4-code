import { describe, expect, it } from "vite-plus/test";
import {
  OMP_RUNTIME_INTEGRATION,
  OMP_RUNTIME_KIND,
  availableRuntimeFeature,
  runtimeIdentityKey,
  unavailableRuntimeFeature,
} from "../src/runtime-integration.ts";

describe("runtime integration contract", () => {
  it("keeps OMP explicit as the first-party integration", () => {
    expect(OMP_RUNTIME_INTEGRATION).toEqual({
      kind: OMP_RUNTIME_KIND,
      displayName: "OMP",
      level: "first-party",
    });
    expect(Object.isFrozen(OMP_RUNTIME_INTEGRATION)).toBe(true);
  });

  it("builds collision-safe identities across runtimes and separators", () => {
    const omp = runtimeIdentityKey({
      runtimeKind: "omp",
      targetId: "local|host",
      hostId: "one",
      sessionId: "two",
    });
    const future = runtimeIdentityKey({
      runtimeKind: "future-runtime",
      targetId: "local",
      hostId: "host|one",
      sessionId: "two",
    });

    expect(omp).not.toBe(future);
    expect(omp).toBe("3:omp|10:local|host|3:one|3:two");
  });

  it("rejects incomplete session identities", () => {
    expect(() =>
      runtimeIdentityKey({ runtimeKind: "omp", targetId: "local", sessionId: "session" }),
    ).toThrow("sessionId requires hostId");
  });

  it("requires a visible reason when a feature is limited", () => {
    expect(availableRuntimeFeature()).toEqual({ status: "available" });
    expect(unavailableRuntimeFeature("This runtime cannot control a browser.")).toEqual({
      status: "unavailable",
      reason: "This runtime cannot control a browser.",
    });
    expect(() => unavailableRuntimeFeature("  ")).toThrow("requires a reason");
  });
});
