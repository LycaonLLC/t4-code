import { describe, expect, it } from "vitest";

import { BrowserNetworkController } from "../src/browser-network.ts";

type BeforeRequestDetails = {
  readonly id: number;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly webContentsId: number;
};

type BeforeRequestListener = (
  details: BeforeRequestDetails,
  callback: (response: { readonly cancel?: boolean; readonly redirectURL?: string }) => void,
) => void;
type HeaderListener = (
  details: { readonly webContentsId: number; readonly requestHeaders: Record<string, string> },
  callback: (response: { readonly requestHeaders: Record<string, string> }) => void,
) => void;
type CompletedListener = (details: BeforeRequestDetails & { readonly statusCode: number }) => void;

class FakeWebRequest {
  beforeRequest: BeforeRequestListener | null = null;
  beforeSendHeaders: HeaderListener | null = null;
  completed: CompletedListener | null = null;

  onBeforeRequest(_filter: unknown, listener: BeforeRequestListener | null): void {
    // Electron keeps only the last listener for a WebRequest event.
    this.beforeRequest = listener;
  }

  onBeforeSendHeaders(_filter: unknown, listener: HeaderListener | null): void { this.beforeSendHeaders = listener; }
  onCompleted(_filter: unknown, listener: CompletedListener | null): void { this.completed = listener; }
  onErrorOccurred(_filter: unknown, _listener: unknown): void {}
}

function headers(
  webRequest: FakeWebRequest,
  webContentsId: number,
): Record<string, string> {
  let result: Record<string, string> = { Accept: "text/html" };
  webRequest.beforeSendHeaders?.(
    { webContentsId, requestHeaders: result },
    (response) => { result = response.requestHeaders; },
  );
  return result;
}

class FakeSession {
  readonly webRequest = new FakeWebRequest();
  networkEmulationCalls = 0;

  enableNetworkEmulation(): void {
    this.networkEmulationCalls += 1;
  }
}

function request(
  webRequest: FakeWebRequest,
  webContentsId: number,
  url: string,
): { readonly cancel?: boolean; readonly redirectURL?: string } {
  let response: { readonly cancel?: boolean; readonly redirectURL?: string } = {};
  webRequest.beforeRequest?.(
    { id: webContentsId, url, method: "GET", resourceType: "mainFrame", webContentsId },
    (value) => {
      response = value;
    },
  );
  return response;
}

describe("BrowserNetworkController session sharing", () => {
  it("keeps request logs and routes scoped when two surfaces share one Electron session", async () => {
    const session = new FakeSession();
    const first = new BrowserNetworkController({
      session: session as never,
      webContents: { id: 11 } as never,
      now: () => 1,
    });
    const second = new BrowserNetworkController({
      session: session as never,
      webContents: { id: 22 } as never,
      now: () => 2,
    });

    expect(first.route({ urlPattern: "https://blocked.example/*", action: "abort" }).ok).toBe(true);
    expect(first.setHeaders({ headers: { "X-T4-Surface": "first" } }).ok).toBe(true);
    expect(second.setHeaders({ headers: { "X-T4-Surface": "second" } }).ok).toBe(true);
    expect(request(session.webRequest, 11, "https://blocked.example/first")).toEqual({ cancel: true });
    expect(request(session.webRequest, 22, "https://allowed.example/second")).toEqual({});
    expect(headers(session.webRequest, 11)).toEqual({ Accept: "text/html", "x-t4-surface": "first" });
    expect(headers(session.webRequest, 22)).toEqual({ Accept: "text/html", "x-t4-surface": "second" });
    session.webRequest.completed?.({
      id: 11,
      url: "https://blocked.example/first",
      method: "GET",
      resourceType: "mainFrame",
      webContentsId: 11,
      statusCode: 403,
    });

    expect(first.listRequests()).toEqual({
      ok: true,
      value: [{
        requestId: 11,
        method: "GET",
        url: "https://blocked.example/first",
        resourceType: "mainFrame",
        startedAt: 1,
        finishedAt: 1,
        statusCode: 403,
      }],
    });
    expect(second.listRequests()).toEqual({
      ok: true,
      value: [{
        requestId: 22,
        method: "GET",
        url: "https://allowed.example/second",
        resourceType: "mainFrame",
        startedAt: 2,
      }],
    });

    await first.dispose();
    expect(request(session.webRequest, 22, "https://allowed.example/after-dispose")).toEqual({});
    expect(second.listRequests().ok).toBe(true);
    await second.dispose();
    expect(session.webRequest.beforeRequest).toBeNull();
  });

  it("fails closed instead of applying session-wide offline mode to sibling tabs", async () => {
    const session = new FakeSession();
    const controller = new BrowserNetworkController({
      session: session as never,
      webContents: { id: 11 } as never,
    });

    expect(controller.setOffline({ offline: true })).toEqual({
      ok: false,
      code: "not_supported",
      message: "Electron network emulation is session-wide and cannot be safely scoped to one browser surface",
      reason: "Electron network emulation is session-wide and cannot be safely scoped to one browser surface",
    });
    expect(session.networkEmulationCalls).toBe(0);
    await controller.dispose();
  });
});
