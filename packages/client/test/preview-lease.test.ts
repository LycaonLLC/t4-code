import { describe, expect, it } from "vite-plus/test";
import { PreviewLeaseManager, type PreviewIdentity } from "../src/index.ts";

describe("PreviewLeaseManager", () => {
  it("binds leases to their full preview identity and releases best-effort", async () => {
    const calls: Array<{ command: string; previewId: string; leaseId?: string }> = [];
    let now = 0;
    const manager = new PreviewLeaseManager(
      {
        previewLeaseAcquire: async (identity) => {
          calls.push({ command: "acquire", previewId: identity.previewId });
          return {
            ok: true,
            result: { previewId: identity.previewId, leaseId: `lease-${identity.previewId}`, expiresAt: 100 },
          };
        },
        previewLeaseRenew: async (identity) => {
          calls.push({
            command: "renew",
            previewId: identity.previewId,
            ...(identity.leaseId === undefined ? {} : { leaseId: identity.leaseId }),
          });
          return {
            ok: true,
            result: { previewId: identity.previewId, leaseId: identity.leaseId, expiresAt: 200 },
          };
        },
        previewLeaseRelease: async (identity) => {
          calls.push({
            command: "release",
            previewId: identity.previewId,
            ...(identity.leaseId === undefined ? {} : { leaseId: identity.leaseId }),
          });
          return { ok: true };
        },
      },
      { now: () => now, defaultTtlMs: 100 },
    );
    const one: PreviewIdentity = { hostId: "host", sessionId: "session", previewId: "one" };
    const two: PreviewIdentity = { hostId: "host", sessionId: "session", previewId: "two" };

    expect(await manager.ensure(one)).toBe("lease-one");
    expect(await manager.ensure(one)).toBe("lease-one");
    expect(calls).toEqual([{ command: "acquire", previewId: "one" }]);
    now = 60;
    expect(await manager.ensure(one)).toBe("lease-one");
    expect(await manager.ensure(two)).toBe("lease-two");
    await manager.release(one);

    expect(calls).toEqual([
      { command: "acquire", previewId: "one" },
      { command: "renew", previewId: "one", leaseId: "lease-one" },
      { command: "acquire", previewId: "two" },
      { command: "release", previewId: "one", leaseId: "lease-one" },
    ]);
  });

  it("invalidates a lease after canonical ownership failures", async () => {
    let acquired = 0;
    const manager = new PreviewLeaseManager({
      previewLeaseAcquire: async (identity) => {
        acquired += 1;
        return {
          ok: true,
          result: {
            previewId: identity.previewId,
            leaseId: `lease-${acquired}`,
            expiresAt: 10_000,
          },
        };
      },
      previewLeaseRenew: async () => ({ ok: true, result: {} }),
      previewLeaseRelease: async () => ({ ok: true }),
    });
    const identity: PreviewIdentity = { hostId: "host", sessionId: "session", previewId: "preview" };

    await expect(
      manager.mutate(identity, async () => Promise.reject({ code: "CONFLICT" })),
    ).rejects.toEqual({ code: "CONFLICT" });
    expect(await manager.ensure(identity)).toBe("lease-2");
    expect(acquired).toBe(2);
  });

  it("fences and releases a lease acquired after teardown", async () => {
    const acquire = Promise.withResolvers<{
      ok: true;
      result: { previewId: string; leaseId: string; expiresAt: number };
    }>();
    const released: string[] = [];
    let mutations = 0;
    const manager = new PreviewLeaseManager({
      previewLeaseAcquire: async () => acquire.promise,
      previewLeaseRenew: async () => ({ ok: true, result: {} }),
      previewLeaseRelease: async (identity) => {
        released.push(identity.leaseId ?? "");
        return { ok: true };
      },
    });
    const identity: PreviewIdentity = {
      hostId: "host",
      sessionId: "session",
      previewId: "preview",
    };

    const pending = manager.mutate(identity, async () => {
      mutations += 1;
    });
    await Promise.resolve();
    await manager.releaseAll();
    acquire.resolve({
      ok: true,
      result: {
        previewId: identity.previewId,
        leaseId: "late-lease",
        expiresAt: Date.now() + 30_000,
      },
    });

    await expect(pending).rejects.toThrow("preview lease acquire invalidated");
    expect(mutations).toBe(0);
    expect(released).toEqual(["late-lease"]);
  });
});
