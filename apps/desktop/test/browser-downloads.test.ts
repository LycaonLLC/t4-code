import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session, WebContents } from "electron";
import type { BrowserEvent, SurfaceId } from "@t4-code/protocol/browser-ipc";

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
  };
};

const vitest = await import("vitest") as unknown as VitestMockApi;

vitest.vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
}));

// The controller must load after Electron is mocked; static import would load the native binding first.
const { BrowserDownloadController } = await import("../src/browser-downloads.ts");

type DownloadListener = (event: FakeDownloadEvent, item: FakeDownloadItem, contents: FakeWebContents) => void;

class FakeDownloadEvent {
  public defaultPrevented = false;

  public preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeWebContents {}

class FakeSession {
  private readonly downloadListeners = new Set<DownloadListener>();

  public on(event: string, listener: DownloadListener): this {
    if (event === "will-download") this.downloadListeners.add(listener);
    return this;
  }

  public removeListener(event: string, listener: DownloadListener): this {
    if (event === "will-download") this.downloadListeners.delete(listener);
    return this;
  }

  public emitWillDownload(item: FakeDownloadItem, contents: FakeWebContents): FakeDownloadEvent {
    const event = new FakeDownloadEvent();
    for (const listener of this.downloadListeners) listener(event, item, contents);
    return event;
  }

  public listenerCount(): number {
    return this.downloadListeners.size;
  }
}

class FakeDownloadItem {
  public savePath: string | undefined;
  private readonly url: string;
  private readonly filename: string;

  public constructor(url: string, filename: string) {
    this.url = url;
    this.filename = filename;
  }

  public getURL(): string {
    return this.url;
  }

  public getFilename(): string {
    return this.filename;
  }

  public getMimeType(): string {
    return "text/plain";
  }

  public getTotalBytes(): number {
    return 0;
  }

  public getReceivedBytes(): number {
    return 0;
  }

  public setSavePath(path: string): void {
    this.savePath = path;
  }

  public on(): this {
    return this;
  }

  public once(): this {
    return this;
  }

  public cancel(): void {}
}

describe("BrowserDownloadController session routing", () => {
  it("uses one listener per session, attributes contents, denies unknown contents, and cleans up", async () => {
    const downloadsPath = await mkdtemp(join(tmpdir(), "t4-browser-downloads-"));
    const emitted: BrowserEvent[] = [];
    const controller = new BrowserDownloadController({
      emit: (event) => { emitted.push(event); },
      downloadsPath,
    });
    const firstSession = new FakeSession();
    const secondSession = new FakeSession();
    const firstContents = new FakeWebContents();
    const secondContents = new FakeWebContents();
    const thirdContents = new FakeWebContents();
    const unknownContents = new FakeWebContents();

    try {
      controller.attach(firstContents as unknown as WebContents, "surface:first" as SurfaceId, firstSession as unknown as Session);
      controller.attach(secondContents as unknown as WebContents, "surface:second" as SurfaceId, firstSession as unknown as Session);
      controller.attach(thirdContents as unknown as WebContents, "surface:third" as SurfaceId, secondSession as unknown as Session);

      expect(firstSession.listenerCount()).toBe(1);
      expect(secondSession.listenerCount()).toBe(1);

      const rejected = firstSession.emitWillDownload(new FakeDownloadItem("https://example.test/unknown", "unknown.txt"), unknownContents);
      expect(rejected.defaultPrevented).toBe(true);
      expect(emitted).toEqual([]);

      const firstItem = new FakeDownloadItem("https://example.test/first", "first.txt");
      const secondItem = new FakeDownloadItem("https://example.test/second", "second.txt");
      const thirdItem = new FakeDownloadItem("https://example.test/third", "third.txt");
      const first = firstSession.emitWillDownload(firstItem, firstContents);
      const second = firstSession.emitWillDownload(secondItem, secondContents);
      const third = secondSession.emitWillDownload(thirdItem, thirdContents);
      expect(first.defaultPrevented).toBe(false);
      expect(second.defaultPrevented).toBe(false);
      expect(third.defaultPrevented).toBe(false);
      expect(firstItem.savePath).toMatch(/^.+\/[.]t4-download-.+[.]part$/u);
      expect(secondItem.savePath).toMatch(/^.+\/[.]t4-download-.+[.]part$/u);
      expect(thirdItem.savePath).toMatch(/^.+\/[.]t4-download-.+[.]part$/u);
      expect(emitted.map((event) => event.type === "download" ? event.download.surfaceId : undefined)).toEqual([
        "surface:first",
        "surface:second",
        "surface:third",
      ]);

      await Promise.resolve();
      await Promise.resolve();
      await controller.dispose();
      expect(firstSession.listenerCount()).toBe(0);
      expect(secondSession.listenerCount()).toBe(0);
    } finally {
      await rm(downloadsPath, { recursive: true, force: true });
    }
  });
});
