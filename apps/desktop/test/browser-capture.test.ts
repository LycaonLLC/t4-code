import { describe, expect, it } from "vitest";

type VitestMockApi = {
  readonly vi: {
    mock(module: string, factory: () => unknown): void;
  };
};

type CaptureRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

interface CaptureImage {
  toPNG(): Uint8Array;
  getSize(): { readonly width: number; readonly height: number };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

// Electron must be mocked before loading the coordinator because native bindings cannot load in Vitest.
const vitest = await import("vitest") as unknown as VitestMockApi;
vitest.vi.mock("electron", () => ({
  contentTracing: {
    startRecording: async () => undefined,
    stopRecording: async () => "",
  },
}));

// This follows the Electron mock above.
const { BrowserCaptureCoordinator } = await import("../src/browser-capture.ts");

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function image(bytes: number[], width = 1_280, height = 720): CaptureImage {
  return {
    toPNG: () => Uint8Array.from(bytes),
    getSize: () => ({ width, height }),
  };
}

class FakeWebContents {
  readonly captureCalls: (CaptureRect | undefined)[] = [];
  readonly emulatedViewports: { readonly width: number; readonly height: number }[] = [];
  readonly zoomFactors: number[] = [];
  private readonly capture: (rect: CaptureRect | undefined) => Promise<CaptureImage>;

  constructor(capture: (rect: CaptureRect | undefined) => Promise<CaptureImage>) {
    this.capture = capture;
  }

  capturePage(rect?: CaptureRect): Promise<CaptureImage> {
    this.captureCalls.push(rect);
    return this.capture(rect);
  }

  enableDeviceEmulation(parameters: { readonly viewSize: { readonly width: number; readonly height: number } }): void {
    this.emulatedViewports.push(parameters.viewSize);
  }

  setZoomFactor(factor: number): void {
    this.zoomFactors.push(factor);
  }
}

describe("BrowserCaptureCoordinator surface identity", () => {
  it("retains a surface viewport across fresh adapter wrappers", async () => {
    const contents = new FakeWebContents(async () => image([1], 640, 480));
    const coordinator = new BrowserCaptureCoordinator();
    const firstAdapter = { surfaceId: "surface-1", webContents: contents };
    const secondAdapter = { surfaceId: "surface-1", webContents: contents };

    await coordinator.call("browser.viewport.set", { width: 640, height: 480 }, firstAdapter);
    await coordinator.call("browser.zoom.set", { zoom: 1.5 }, firstAdapter);
    await coordinator.call("surface.screenshot", {}, secondAdapter);

    expect(contents.emulatedViewports).toEqual([{ width: 640, height: 480 }]);
    expect(contents.zoomFactors).toEqual([1.5]);
    expect(contents.captureCalls).toEqual([{ x: 0, y: 0, width: 640, height: 480 }]);
  });

  it("coalesces identical captures only for the same surface", async () => {
    const response = deferred<CaptureImage>();
    const contents = new FakeWebContents(() => response.promise);
    const coordinator = new BrowserCaptureCoordinator();
    const firstAdapter = { surfaceId: "surface-1", webContents: contents };
    const secondAdapter = { surfaceId: "surface-1", webContents: contents };

    const first = coordinator.call("surface.screenshot", { crop: { x: 0, y: 0, width: 10, height: 10 } }, firstAdapter);
    const second = coordinator.call("surface.screenshot", { crop: { width: 10, height: 10, y: 0, x: 0 } }, secondAdapter);

    expect(contents.captureCalls).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
    response.resolve(image([1], 10, 10));
    expect(await Promise.all([first, second])).toEqual([
      { supported: true, mimeType: "image/png", width: 10, height: 10, data: "AQ==" },
      { supported: true, mimeType: "image/png", width: 10, height: 10, data: "AQ==" },
    ]);
  });

  it("does not coalesce different capture options for one surface", async () => {
    const firstResponse = deferred<CaptureImage>();
    const secondResponse = deferred<CaptureImage>();
    const contents = new FakeWebContents((rect) => rect?.width === 10 ? firstResponse.promise : secondResponse.promise);
    const coordinator = new BrowserCaptureCoordinator();
    const surface = { surfaceId: "surface-1", webContents: contents };

    const first = coordinator.call("surface.screenshot", { crop: { x: 0, y: 0, width: 10, height: 10 } }, surface);
    const second = coordinator.call("surface.screenshot", { crop: { x: 0, y: 0, width: 20, height: 10 } }, surface);

    expect(contents.captureCalls).toEqual([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 20, height: 10 },
    ]);
    firstResponse.resolve(image([1], 10, 10));
    secondResponse.resolve(image([2], 20, 10));
    expect(await Promise.all([first, second])).toEqual([
      { supported: true, mimeType: "image/png", width: 10, height: 10, data: "AQ==" },
      { supported: true, mimeType: "image/png", width: 20, height: 10, data: "Ag==" },
    ]);
  });

  it("keeps concurrent captures isolated between surfaces", async () => {
    const firstResponse = deferred<CaptureImage>();
    const secondResponse = deferred<CaptureImage>();
    const firstContents = new FakeWebContents(() => firstResponse.promise);
    const secondContents = new FakeWebContents(() => secondResponse.promise);
    const coordinator = new BrowserCaptureCoordinator();

    const first = coordinator.call("surface.screenshot", {}, { surfaceId: "surface-1", webContents: firstContents });
    const second = coordinator.call("surface.screenshot", {}, { surfaceId: "surface-2", webContents: secondContents });

    expect(firstContents.captureCalls).toEqual([{ x: 0, y: 0, width: 1_280, height: 720 }]);
    expect(secondContents.captureCalls).toEqual([{ x: 0, y: 0, width: 1_280, height: 720 }]);
    firstResponse.resolve(image([1]));
    secondResponse.resolve(image([2]));
    expect(await Promise.all([first, second])).toEqual([
      { supported: true, mimeType: "image/png", width: 1_280, height: 720, data: "AQ==" },
      { supported: true, mimeType: "image/png", width: 1_280, height: 720, data: "Ag==" },
    ]);
  });
});
