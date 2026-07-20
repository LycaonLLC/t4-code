import { describe, expect, it } from "vitest";

type Listener = (...args: unknown[]) => void;
type PermissionRequestHandler = (contents: FakeWebContents, permission: string, callback: (allowed: boolean) => void, details?: { readonly requestingUrl?: string; readonly isMainFrame?: boolean }) => void;
type WindowOpenHandler = (details: { readonly url: string; readonly frameName: string; readonly disposition: string; readonly referrer: { readonly url: string } }) => { readonly action: string };

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
  };
};

const vitest = await import("vitest") as unknown as VitestMockApi;

class FakeWebContents {
  readonly listeners = new Map<string, Listener[]>();
  windowOpenHandler: WindowOpenHandler | null = null;
  url = "https://example.test/";

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: Listener): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  getURL(): string {
    return this.url;
  }

  setWindowOpenHandler(handler: WindowOpenHandler): void {
    this.windowOpenHandler = handler;
  }
}

class FakeSession {
  readonly listeners = new Map<string, Listener[]>();
  permissionRequestHandler: PermissionRequestHandler | null = null;
  permissionCheckHandler: ((contents: FakeWebContents) => boolean) | null = null;
  proxyChanges = 0;

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: Listener): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  setPermissionRequestHandler(handler: PermissionRequestHandler | null): void {
    this.permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(handler: ((contents: FakeWebContents) => boolean) | null): void {
    this.permissionCheckHandler = handler;
  }

  async setProxy(): Promise<void> { this.proxyChanges += 1; }

  async closeAllConnections(): Promise<void> {}
}

vitest.vi.mock("electron", () => ({
  app: { on: () => {}, off: () => {} },
}));

const { installBrowserSurfaceSecurity } = await import("../src/browser-security.ts");
const profile = { kind: "isolated-session", profileId: "test-profile" } as never;

function createController(session: FakeSession, webContents: FakeWebContents, options: { readonly onPopup?: (request: { readonly url: string }) => boolean; readonly onDownload?: (request: { readonly url: string; readonly filename: string }) => boolean; readonly onPermissionPrompt?: () => boolean } = {}) {
  return installBrowserSurfaceSecurity({
    session: session as never,
    webContents: webContents as never,
    profile,
    onPopup: options.onPopup as never,
    onDownload: options.onDownload as never,
    onPermissionPrompt: options.onPermissionPrompt as never,
  });
}

function cancelableEvent(): { prevented: boolean; preventDefault(): void } {
  return {
    prevented: false,
    preventDefault(): void { this.prevented = true; },
  };
}

describe("browser surface security", () => {
  it("prevents unsafe main-frame navigations", () => {
    const session = new FakeSession();
    const webContents = new FakeWebContents();
    const controller = createController(session, webContents);
    const event = cancelableEvent();

    webContents.emit("will-navigate", event, "file:///private/secret", false, true);

    expect(event.prevented).toBe(true);
    controller.dispose();
  });

  it("creates only a managed popup and denies Electron's original child", () => {
    const session = new FakeSession();
    const webContents = new FakeWebContents();
    const requests: string[] = [];
    const controller = createController(session, webContents, {
      onPopup: (request) => {
        requests.push(request.url);
        return true;
      },
    });
    const handler = webContents.windowOpenHandler;
    if (!handler) throw new Error("Popup handler was not installed");

    const result = handler({
      url: "https://popup.example.test/",
      frameName: "report",
      disposition: "new-window",
      referrer: { url: "https://example.test/" },
    });

    expect(requests).toEqual(["https://popup.example.test/"]);
    expect(result).toEqual({ action: "deny" });
    controller.dispose();
  });

  it("keeps shared-session permission routing active until its last surface disposes", () => {
    const session = new FakeSession();
    const firstContents = new FakeWebContents();
    const secondContents = new FakeWebContents();
    const first = createController(session, firstContents, { onPermissionPrompt: () => false });
    const second = createController(session, secondContents, { onPermissionPrompt: () => true });
    const handler = session.permissionRequestHandler;
    if (!handler) throw new Error("Permission request handler was not installed");
    const decisions: boolean[] = [];

    handler(firstContents, "notifications", (allowed) => decisions.push(allowed), { requestingUrl: "https://first.example.test/", isMainFrame: true });
    handler(secondContents, "notifications", (allowed) => decisions.push(allowed), { requestingUrl: "https://second.example.test/", isMainFrame: true });
    first.dispose();

    expect(decisions).toEqual([false, true]);
    expect(session.permissionRequestHandler).toBe(handler);
    expect(session.permissionCheckHandler?.(secondContents)).toBe(false);
    handler(secondContents, "notifications", (allowed) => decisions.push(allowed), { requestingUrl: "https://second.example.test/", isMainFrame: true });
    expect(decisions).toEqual([false, true, true]);

    second.dispose();
    expect(session.permissionRequestHandler).toBe(null);
    expect(session.permissionCheckHandler).toBe(null);
  });

  it("does not cancel a sibling surface download but denies unsafe own downloads", () => {
    const session = new FakeSession();
    const firstContents = new FakeWebContents();
    const secondContents = new FakeWebContents();
    const first = createController(session, firstContents, { onDownload: () => true });
    const second = createController(session, secondContents, { onDownload: () => true });
    const siblingDownload = cancelableEvent();

    session.emit("will-download", siblingDownload, { getURL: () => "https://example.test/report.csv", getFilename: () => "report.csv" }, secondContents);

    expect(siblingDownload.prevented).toBe(false);
    const unsafeOwnDownload = cancelableEvent();
    session.emit("will-download", unsafeOwnDownload, { getURL: () => "file:///private/secret", getFilename: () => "secret.txt" }, firstContents);
    expect(unsafeOwnDownload.prevented).toBe(true);

    first.dispose();
    second.dispose();
  });

  it("fails closed instead of replacing the shared session proxy", async () => {
    const session = new FakeSession();
    const controller = createController(session, new FakeWebContents());

    expect(await controller.configureProxy({ mode: "fixed", proxy: "https://proxy.example.test:443" })).toEqual({
      ok: false,
      code: "not_supported",
      message: "Electron proxy configuration is session-wide and cannot be safely scoped to one browser surface",
    });
    controller.dispose();
    await Promise.resolve();

    expect(session.proxyChanges).toBe(0);
  });
});
