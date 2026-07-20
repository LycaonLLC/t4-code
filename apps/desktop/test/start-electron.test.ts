import { describe, expect, it } from "vitest";

const launcherUrl = new URL("../scripts/start-electron.mjs", import.meta.url);

function loadLauncher() {
  return import(`${launcherUrl.href}?test=${crypto.randomUUID()}`);
}

describe("Electron launcher", () => {
  it("removes Electron's Node mode without mutating the source environment", async () => {
    const { sanitizeEnvironment } = await loadLauncher();
    const environment = { ELECTRON_RUN_AS_NODE: "1", KEEP: "value" };

    expect(sanitizeEnvironment(environment)).toEqual({ KEEP: "value" });
    expect(environment).toEqual({ ELECTRON_RUN_AS_NODE: "1", KEEP: "value" });
  });

  it("accepts only loopback HTTP renderer URLs", async () => {
    const { validateLoopbackRendererUrl } = await loadLauncher();

    expect(validateLoopbackRendererUrl("http://127.0.0.1:5173/")?.origin).toBe("http://127.0.0.1:5173");
    expect(validateLoopbackRendererUrl("https://localhost:5173/")?.hostname).toBe("localhost");
    expect(validateLoopbackRendererUrl("http://[::1]:5173/")?.hostname).toBe("[::1]");
    expect(validateLoopbackRendererUrl(undefined)).toBeUndefined();

    for (const value of ["ftp://localhost", "http://example.com", "not a URL"]) {
      expect(() => validateLoopbackRendererUrl(value)).toThrow("OMP_DESKTOP_RENDERER_URL must be a loopback HTTP URL");
    }
  });

  it("waits until the configured renderer responds successfully", async () => {
    const { waitForRenderer } = await loadLauncher();
    const requests: Array<{ url: URL; method?: string }> = [];

    await waitForRenderer("http://127.0.0.1:5173/", {
      fetchImpl: async (url: URL, init: RequestInit) => {
        requests.push({ url, method: init.method ?? "" });
        return { ok: true };
      },
      sleep: async () => {
        throw new Error("should not sleep after a successful response");
      },
    });

    expect(requests).toEqual([{ url: new URL("http://127.0.0.1:5173/"), method: "HEAD" }]);
  });

  it("times out renderer readiness using injected clocks and sleeps", async () => {
    const { waitForRenderer } = await loadLauncher();
    let time = 0;
    let requests = 0;

    await expect(waitForRenderer("http://localhost:5173/", {
      fetchImpl: async () => {
        requests += 1;
        return { ok: false };
      },
      now: () => time,
      sleep: async (milliseconds: number) => {
        time += milliseconds;
      },
      timeoutMs: 200,
      intervalMs: 100,
    })).rejects.toThrow("Renderer did not become ready at http://localhost:5173");

    expect(requests).toBe(3);
  });

  it("does not run the launcher when the module is imported", async () => {
    const originalRendererUrl = process.env.OMP_DESKTOP_RENDERER_URL;
    process.env.OMP_DESKTOP_RENDERER_URL = "not a URL";

    try {
      const launcher = await loadLauncher();
      expect(typeof launcher.main).toBe("function");
      expect(typeof launcher.startElectron).toBe("function");
    } finally {
      if (originalRendererUrl === undefined) delete process.env.OMP_DESKTOP_RENDERER_URL;
      else process.env.OMP_DESKTOP_RENDERER_URL = originalRendererUrl;
    }
  });
});
