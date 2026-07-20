import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_IPC_VERSION,
  BrowserProtocolError,
  decodeBrowserCall,
  decodeBrowserEvent,
  decodeBrowserRequest,
  decodeBrowserResult,
} from "../src/browser-ipc.ts";

const SURFACE_ID = "123e4567-e89b-12d3-a456-426614174000";

function surface(lifecycle: "creating" | "loading" | "ready" | "closed" | "crashed" | "failed" = "ready") {
  return {
    surfaceId: SURFACE_ID,
    handle: "surface:1",
    profile: { kind: "isolated-session", profileId: "isolated-session" },
    url: "https://example.test/",
    title: "Example",
    lifecycle,
    readyState: "complete",
    loading: false,
    progress: 1,
    canGoBack: false,
    canGoForward: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: true,
    muted: false,
    focused: "webview",
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("browser IPC boundary", () => {
  it("decodes bounded multiline design-mode requests and status", () => {
    const call = decodeBrowserCall({
      version: BROWSER_IPC_VERSION,
      method: "browser.design_mode.set",
      ownerSessionId: "session-a",
      request: {
        surfaceId: SURFACE_ID,
        enabled: true,
        prompt: "Tighten the heading\nand preserve spacing.",
      },
    });
    expect(call.request).toEqual({
      surfaceId: SURFACE_ID,
      enabled: true,
      prompt: "Tighten the heading\nand preserve spacing.",
    });

    expect(
      decodeBrowserResult("browser.design_mode.status", {
        enabled: true,
        prompt: "Tighten the heading",
        selection: "Heading\nSupporting copy",
      }),
    ).toEqual({
      enabled: true,
      prompt: "Tighten the heading",
      selection: "Heading\nSupporting copy",
    });
  });

  it("decodes every browser surface lifecycle", () => {
    for (const lifecycle of ["creating", "loading", "ready", "closed", "crashed", "failed"] as const) {
      expect(decodeBrowserResult("surface.get", { surface: surface(lifecycle) })).toMatchObject({
        surface: { lifecycle },
      });
    }
  });

  it("preserves surface bounds visibility", () => {
    expect(decodeBrowserCall({
      version: BROWSER_IPC_VERSION,
      method: "surface.setBounds",
      request: {
        surfaceId: SURFACE_ID,
        bounds: { x: -24, y: 12, width: 1_280, height: 720 },
        visible: false,
      },
    })).toEqual({
      version: BROWSER_IPC_VERSION,
      method: "surface.setBounds",
      request: {
        surfaceId: SURFACE_ID,
        bounds: { x: -24, y: 12, width: 1_280, height: 720 },
        visible: false,
      },
    });
  });

  it("rejects bounded automation input that exceeds the protocol limit", () => {
    expect(() => decodeBrowserRequest("surface.type", {
      surfaceId: SURFACE_ID,
      text: "x".repeat(16_385),
    })).toThrow(BrowserProtocolError);
  });

  it("decodes browser state, download, console, and error events", () => {
    expect(decodeBrowserEvent({ type: "state", surface: surface("loading") })).toMatchObject({
      type: "state",
      surface: { lifecycle: "loading" },
    });
    expect(decodeBrowserEvent({
      type: "download",
      download: {
        downloadId: "download-1",
        surfaceId: SURFACE_ID,
        state: "completed",
        url: "https://example.test/report.csv",
        filename: "report.csv",
        totalBytes: 42,
        receivedBytes: 42,
      },
    })).toMatchObject({ type: "download", download: { state: "completed", receivedBytes: 42 } });
    expect(decodeBrowserEvent({
      type: "console",
      console: {
        level: "info",
        message: "ready",
        args: ["page", { count: 1 }],
        timestamp: 3,
        surfaceId: SURFACE_ID,
      },
    })).toMatchObject({ type: "console", console: { level: "info", args: ["page", { count: 1 }] } });
    expect(decodeBrowserEvent({
      type: "error",
      error: {
        surfaceId: SURFACE_ID,
        kind: "navigation",
        code: "ERR_ABORTED",
        message: "Navigation stopped",
        fatal: false,
        timestamp: 4,
      },
    })).toMatchObject({ type: "error", error: { kind: "navigation", fatal: false } });
  });

  it("requires an exact explicit opt-in for authenticated profiles", () => {
    const profile = {
      kind: "authenticated-profile",
      profileId: "work-browser",
      explicitOptIn: true,
    };
    expect(decodeBrowserRequest("surface.create", { profile })).toEqual({ profile });
    for (const invalidProfile of [
      { kind: "authenticated-profile", profileId: "work-browser" },
      { kind: "authenticated-profile", profileId: "work-browser", explicitOptIn: false },
      { kind: "authenticated-profile", profileId: "work-browser", explicitOptIn: true, autoSelect: true },
    ]) expect(() => decodeBrowserRequest("surface.create", { profile: invalidProfile })).toThrow(BrowserProtocolError);
    expect(() => decodeBrowserRequest("surface.create", {})).toThrow(BrowserProtocolError);
  });

  it("passes a representative generic browser automation call through the bounded JSON boundary", () => {
    expect(decodeBrowserCall({
      version: BROWSER_IPC_VERSION,
      method: "browser.click",
      request: { selector: "#continue", button: "left", clickCount: 1 },
    })).toEqual({
      version: BROWSER_IPC_VERSION,
      method: "browser.click",
      request: { selector: "#continue", button: "left", clickCount: 1 },
    });
  });

  it("decodes generic startup and diagnostic browser results", () => {
    for (const [method, result] of [
      ["browser.profiles.list", { profiles: [{ profileId: "isolated-session", label: "Isolated session" }] }],
      ["browser.console.list", { messages: [{ level: "info", message: "Browser started", timestamp: 1 }] }],
      ["browser.errors.list", { errors: [{ code: "ERR_ABORTED", message: "Navigation stopped" }] }],
    ] as const) {
      expect(decodeBrowserResult(method, result)).toEqual(result);
    }
  });

  it("keeps generic browser results bounded and secret-free", () => {
    expect(() => decodeBrowserResult("browser.profiles.list", { token: "secret" })).toThrow(BrowserProtocolError);
    expect(() => decodeBrowserResult("browser.profiles.list", { payload: "x".repeat(1_048_577) })).toThrow(BrowserProtocolError);
    expect(() => decodeBrowserResult("browser.profiles.list", { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: { nested: 1 } } } } } } } } })).toThrow(BrowserProtocolError);
    expect(() => decodeBrowserResult("browser.profiles.list", { items: Array.from({ length: 257 }, () => 1) })).toThrow(BrowserProtocolError);
    expect(() => decodeBrowserResult("browser.profiles.list", Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, index])))).toThrow(BrowserProtocolError);
  });

  it("keeps specialized browser result schemas exact", () => {
    expect(() => decodeBrowserResult("surface.list", { surfaces: [], extra: true })).toThrow(BrowserProtocolError);
  });
});
