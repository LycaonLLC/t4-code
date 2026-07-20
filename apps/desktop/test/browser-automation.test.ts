import { describe, expect, it } from "vitest";
import type { IpcMain } from "electron";

function ipcMainMock(): Pick<IpcMain, "on" | "removeListener"> {
  const ipcMain = {
    on: () => ipcMain as unknown as IpcMain,
    removeListener: () => ipcMain as unknown as IpcMain,
  };
  return ipcMain;
}

function field(value: unknown, name: string): unknown {
  expect(value !== null && typeof value === "object" && name in value).toBe(true);
  if (value === null || typeof value !== "object" || !(name in value)) return undefined;
  return (value as Record<string, unknown>)[name];
}

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
    useFakeTimers(): void;
    useRealTimers(): void;
    advanceTimersByTimeAsync(milliseconds: number): Promise<void>;
  };
};

// Electron must be mocked before loading the coordinator because native bindings cannot load in Vitest.
const vitest = await import("vitest") as unknown as VitestMockApi;
vitest.vi.mock("electron", () => ({ ipcMain: ipcMainMock() }));

// This follows the Electron mock above.
const { BrowserAutomationCoordinator } = await import("../src/browser-automation.ts");

type EvaluationResult = { readonly ok: boolean; readonly value?: unknown; readonly error?: string };

class FakeWebContents {
  readonly scripts: string[] = [];
  sent = 0;
  destroyed = false;
  handler: (script: string) => Promise<EvaluationResult> = async () => ({ ok: true, value: null });

  isDestroyed(): boolean { return this.destroyed; }
  send(): void { this.sent += 1; }
  executeJavaScript(script: string): Promise<EvaluationResult> {
    this.scripts.push(script);
    return this.handler(script);
  }
}

function harness(contents = new FakeWebContents()): { readonly contents: FakeWebContents; readonly coordinator: InstanceType<typeof BrowserAutomationCoordinator>; readonly surface: { surfaceId: string; webContents: FakeWebContents; browserSession: object; waitForContentReady: (timeoutMs: number) => Promise<void> } } {
  const surface = {
    surfaceId: "surface-1",
    webContents: contents,
    browserSession: {},
    waitForContentReady: async (_timeoutMs: number) => {},
  };
  const coordinator = new BrowserAutomationCoordinator({
    ipcMain: ipcMainMock(),
    resolveSurface: () => surface as never,
  });
  return { contents, coordinator, surface };
}

function call(coordinator: InstanceType<typeof BrowserAutomationCoordinator>, method: "browser.eval" | "browser.wait", request: Record<string, unknown>): Promise<unknown> {
  return coordinator.call({ method, request } as never);
}

describe("BrowserAutomationCoordinator native evaluation", () => {
  it("evaluates document.title through the live WebContents despite page CSP", async () => {
    const { contents, coordinator } = harness();
    contents.handler = async (script) => {
      expect(script).toContain("document.title");
      expect(script).not.toContain("new Function");
      return { ok: true, value: "Example Domain" };
    };

    const result = await call(coordinator, "browser.eval", { expression: "document.title" });
    expect(field(result, "value")).toBe("Example Domain");
    expect(contents.sent).toBe(0);
  });

  it("bounds cyclic and oversized evaluation results before returning them", async () => {
    const { contents, coordinator } = harness();
    contents.handler = async () => ({ ok: true, value: { cycle: "[unavailable]", entries: Array.from({ length: 600 }, () => "value") } });

    const result = await call(coordinator, "browser.eval", { expression: "window.cyclic" });
    const value = field(result, "value");
    expect(field(value, "cycle")).toBe("[unavailable]");
    const entries = field(value, "entries");
    expect(Array.isArray(entries)).toBe(true);
    if (!Array.isArray(entries)) throw new Error("Expected bounded entries");
    expect(entries.length).toBe(256);
    expect(entries.every((entry) => entry === "value")).toBe(true);
    expect(contents.scripts[0]).toContain('seen.has(value)');
  });

  it("rejects denied Node and Electron expressions without executing page code", async () => {
    const { contents, coordinator } = harness();

    let failure: unknown;
    try {
      await call(coordinator, "browser.eval", { expression: 'require("node:fs")' });
    } catch (error) {
      failure = error;
    }
    expect(field(failure, "code")).toBe("security");
    expect(field(failure, "message")).toBe("Node and Electron objects are unavailable");
    expect(contents.scripts).toEqual([]);
  });

  it("fails timed-out and stale WebContents evaluations", async () => {
    vitest.vi.useFakeTimers();
    try {
      const timeout = harness();
      timeout.contents.handler = () => new Promise<EvaluationResult>(() => {});
      const pending = call(timeout.coordinator, "browser.eval", { expression: "document.title", timeoutMs: 20 });
      const failure = (async () => {
        try {
          await pending;
        } catch (error) {
          return error;
        }
        throw new Error("Expected evaluation to time out");
      })();
      await vitest.vi.advanceTimersByTimeAsync(20);
      expect(field(await failure, "code")).toBe("timeout");
    } finally {
      vitest.vi.useRealTimers();
    }

    const stale = harness();
    const evaluationStarted = Promise.withResolvers<void>();
    const evaluationResult = Promise.withResolvers<EvaluationResult>();
    stale.contents.handler = () => {
      evaluationStarted.resolve();
      return evaluationResult.promise;
    };
    const pending = call(stale.coordinator, "browser.eval", { expression: "document.title", timeoutMs: 1_000 });
    const failure = (async () => {
      try {
        await pending;
      } catch (error) {
        return error;
      }
      throw new Error("Expected stale evaluation to fail");
    })();
    await evaluationStarted.promise;
    stale.surface.webContents = new FakeWebContents();
    evaluationResult.resolve({ ok: true, value: "Example Domain" });
    expect(field(await failure, "code")).toBe("invalid_state");
  });

  it("uses the same native evaluator for function waits", async () => {
    const { contents, coordinator } = harness();
    contents.handler = async (script) => {
      expect(script).toContain("document.readyState === \"complete\"");
      return { ok: true, value: true };
    };

    const result = await call(coordinator, "browser.wait", { kind: "function", value: 'document.readyState === "complete"' });
    expect(field(result, "matched")).toBe(true);
    expect(contents.sent).toBe(0);
  });
});
