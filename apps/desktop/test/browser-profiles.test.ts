import { describe, expect, it } from "vitest";

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
  };
};

class FakeProfileSession {
  clearStorageCalls = 0;
  clearCacheCalls = 0;
  readonly cookieWrites: unknown[] = [];
  readonly cookies = {
    set: async (details: unknown): Promise<void> => {
      this.cookieWrites.push(details);
    },
  };

  async clearStorageData(): Promise<void> {
    this.clearStorageCalls += 1;
  }

  async clearCache(): Promise<void> {
    this.clearCacheCalls += 1;
  }
}

const electron = (() => {
  const sessions = new Map<string, FakeProfileSession>();
  return {
    sessions,
    fromPartition: (partition: string): FakeProfileSession => {
      let profileSession = sessions.get(partition);
      if (profileSession === undefined) {
        profileSession = new FakeProfileSession();
        sessions.set(partition, profileSession);
      }
      return profileSession;
    },
    reset: (): void => {
      sessions.clear();
    },
  };
})();

// Native Electron bindings cannot load in Vitest.
const vitest = await import("vitest") as unknown as VitestMockApi;
vitest.vi.mock("electron", () => ({ session: { fromPartition: electron.fromPartition } }));

const { BrowserProfileRegistry } = await import("../src/browser-profiles.ts");
const { BrowserProfileAutomation } = await import("../src/browser-profile-automation.ts");

class MemoryProfileStore {
  store: unknown = { version: 1, records: [] };

  set(key: string, value: unknown): void {
    this.store = { ...(this.store as Record<string, unknown>), [key]: value };
  }
}

function registry(): InstanceType<typeof BrowserProfileRegistry> {
  electron.reset();
  return new BrowserProfileRegistry({
    store: new MemoryProfileStore(),
    session: { fromPartition: (partition) => electron.fromPartition(partition) as never },
    now: () => 1_700_000_000_000,
  });
}

function expectSecurity(result: { readonly ok: boolean; readonly code?: string }): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected profile selection to be rejected");
  expect(result.code).toBe("security");
}

describe("BrowserProfileRegistry isolated sessions", () => {
  it("uses one in-memory Electron session per owning OMP session", () => {
    const profiles = registry();
    const isolated = { kind: "isolated-session", profileId: "isolated-session" } as const;

    const first = profiles.getSession(isolated, "host-a/workspace-session-a");
    const sameOwner = profiles.getSession(isolated, "host-a/workspace-session-a");
    const second = profiles.getSession(isolated, "host-b/workspace-session-b");

    expect(first).toBe(sameOwner);
    expect(first).not.toBe(second);
    expect(electron.sessions.size).toBe(2);
    expect([...electron.sessions.keys()].every((partition) => !partition.includes("workspace-session"))).toBe(true);
  });

  it("continues sharing an explicitly selected authenticated profile", () => {
    const profiles = registry();
    const metadata = profiles.create({ profileId: "work" });
    const authenticated = {
      kind: "authenticated-profile",
      profileId: metadata.profileId,
      explicitOptIn: true,
    } as const;

    expect(profiles.getSession(authenticated, "workspace-session-a")).toBe(
      profiles.getSession(authenticated, "workspace-session-b"),
    );
  });
});

describe("BrowserProfileRegistry active profile counts", () => {
  it("keeps a profile in use until both tabs release it without underflow", async () => {
    const profiles = registry();
    const profile = profiles.create({ profileId: "work" });

    profiles.markInUse("isolated-session");
    expect(profiles.isInUse("isolated-session")).toBe(false);

    profiles.markInUse(profile.profileId);
    profiles.markInUse(profile.profileId);
    expect(profiles.isInUse(profile.profileId)).toBe(true);
    await expect(profiles.delete(profile.profileId)).rejects.toThrow("browser profile is in use");

    profiles.release(profile.profileId);
    expect(profiles.isInUse(profile.profileId)).toBe(true);
    await expect(profiles.delete(profile.profileId)).rejects.toThrow("browser profile is in use");

    profiles.release(profile.profileId);
    profiles.release(profile.profileId);
    expect(profiles.isInUse(profile.profileId)).toBe(false);
    expect(await profiles.delete(profile.profileId)).toBe(true);
  });
});

describe("BrowserProfileAutomation authenticated mutations", () => {
  it("requires a matching explicit authenticated profile for every mutation", async () => {
    const profiles = registry();
    const profile = profiles.create({ profileId: "work" });
    const matchingProfile = { kind: "authenticated-profile", profileId: profile.profileId, explicitOptIn: true } as const;
    const session = electron.fromPartition(profile.partition);
    let readCalls = 0;
    const automation = new BrowserProfileAutomation({
      registry: profiles,
      readFile: async () => {
        readCalls += 1;
        return JSON.stringify([{ name: "sid", value: "value", domain: "example.test", path: "/", secure: true }]);
      },
    });
    const invalidSelections = [
      { profileId: profile.profileId },
      { profileId: profile.profileId, profile: { kind: "authenticated-profile", profileId: "other", explicitOptIn: true } },
      { profileId: profile.profileId, profile: { kind: "authenticated-profile", profileId: profile.profileId, explicitOptIn: false } },
      { profileId: profile.profileId, profile: { kind: "isolated-session", profileId: "isolated-session" } },
      { profileId: profile.profileId, profile: null },
    ];

    for (const selection of invalidSelections) {
      expectSecurity(await automation.clear(selection as never));
      expectSecurity(await automation.delete(selection as never));
      expectSecurity(await automation.importCookies({ ...selection, filePath: "/selected/cookies.json" } as never));
    }
    expect(session.clearStorageCalls).toBe(0);
    expect(session.clearCacheCalls).toBe(0);
    expect(session.cookieWrites).toEqual([]);
    expect(readCalls).toBe(0);
    expect(profiles.resolve(profile.profileId).profileId).toBe(profile.profileId);

    const cleared = await automation.clear({ profileId: profile.profileId, profile: matchingProfile });
    expect(cleared.ok).toBe(true);
    expect(session.clearStorageCalls).toBe(1);
    expect(session.clearCacheCalls).toBe(1);

    const imported = await automation.importCookies({ profileId: profile.profileId, profile: matchingProfile, filePath: "/selected/cookies.json" });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("Expected cookies to import");
    expect(imported.value).toEqual({ profileId: profile.profileId, imported: 1, selected: false });
    expect(readCalls).toBe(1);
    expect(session.cookieWrites).toHaveLength(1);

    const deleted = await automation.delete({ profileId: profile.profileId, profile: matchingProfile });
    expect(deleted.ok).toBe(true);
    expect(session.clearStorageCalls).toBe(2);
    expect(session.clearCacheCalls).toBe(2);
    expect(() => profiles.resolve(profile.profileId)).toThrow("authenticated browser profile was not found");

    const isolated = await automation.clear({ profileId: "isolated-session", profile: { kind: "isolated-session", profileId: "isolated-session" } });
    expectSecurity(isolated);
  });
});
