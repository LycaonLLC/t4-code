import { describe, expect, it } from "vitest";
import type { ServiceAvailabilityIssue } from "@t4-code/protocol/desktop-ipc";
import type { ServiceManager } from "@t4-code/service-manager";
import { DesktopIpcRegistry, runtimeError, type IpcMainLike, type IpcRuntime } from "../src/ipc.ts";

class FakeIpc implements IpcMainLike {
  readonly handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  handle(channel: string, listener: (event: never, payload: unknown) => unknown): void { this.handlers.set(channel, listener as never); }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
}
function fakeWindow() {
  const frame = { url: "file:///trusted/index.html" };
  const sent: unknown[][] = [];
  const webContents = { mainFrame: frame, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) };
  const window = { webContents, isDestroyed: () => false };
  return { window, sent };
}
function makeRuntime(serviceManager?: ServiceManager, serviceAvailabilityIssue?: ServiceAvailabilityIssue) {
  const view = fakeWindow();
  const manager = { isConnected: () => true, connect: async () => "connected", disconnect: async () => {}, command: async () => ({ targetId: "local", requestId: "1", commandId: "1", accepted: true }), pairStart: async () => ({ targetId: "remote", paired: true }), listTargets: async () => [], addRemoteTarget: async (target: unknown) => target, removeTarget: async () => {} };
  return { view, runtime: { manager, window: view.window, trustedRenderer: { origin: "file://", url: "file:///trusted/index.html" }, ...(serviceManager === undefined ? {} : { serviceManager }), ...(serviceAvailabilityIssue === undefined ? {} : { getServiceAvailabilityIssue: () => serviceAvailabilityIssue }) } as unknown as IpcRuntime };
}
const request = (channel: string, payload: unknown = {}): unknown => ({ channel, payload });

describe("desktop IPC lifecycle proof", () => {
  it("rejects payload keys and channel/action mismatches at the invoke boundary", async () => {
    const ipc = new FakeIpc();
    const { runtime } = makeRuntime();
    new DesktopIpcRegistry(runtime, ipc).install();
    const handler = ipc.handlers.get("omp:targets:list")!;
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    await expect(handler(event, request("omp:targets:list", { extra: true }))).rejects.toThrow();
    await expect(handler(event, request("omp:connect", {}))).rejects.toThrow();
  });
  it("serializes concurrent service actions", async () => {
    const ipc = new FakeIpc();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const serviceManager = { inspect: async () => ({ definition: "current", service: "running", diagnostics: "ok" }), start: async () => { order.push("start"); await gate; }, stop: async () => { order.push("stop"); } } as never as ServiceManager;
    const { runtime } = makeRuntime(serviceManager);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const start = ipc.handlers.get("omp:service:start")!(event, request("omp:service:start"));
    const stop = ipc.handlers.get("omp:service:stop")!(event, request("omp:service:stop"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start"]);
    release();
    await Promise.all([start, stop]);
    expect(order).toEqual(["start", "stop"]);
  });
  it("bounds service inspection and redacts diagnostic details", async () => {
    const ipc = new FakeIpc();
    const serviceManager = { inspect: async () => ({ definition: "drifted", service: "failed", diagnostics: `Authorization: Bearer BEARER_SECRET authorization=Basic BASIC_SECRET token=SECRET https://private.example/x "/Users/alice/My Secret/file" '/home/alice/My Secret/file' /usr/local/private ~/Library/Application Support/Secret ${"x".repeat(1000)}` }) } as never as ServiceManager;
    const { runtime } = makeRuntime(serviceManager);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const result = await ipc.handlers.get("omp:service:inspect")!(event, request("omp:service:inspect"));
    const inspection = result as { diagnostics: string };
    expect(inspection.diagnostics.length).toBeLessThanOrEqual(512);
    expect(inspection.diagnostics).not.toContain("SECRET");
    expect(inspection.diagnostics).not.toContain("/Users/alice");
    expect(inspection.diagnostics).not.toContain("/home/alice");
    expect(inspection.diagnostics).not.toContain("/usr/local");
    expect(inspection.diagnostics).not.toContain("~/Library");
    const error = runtimeError(new Error("failed Authorization: Bearer BEARER_SECRET authorization=Basic BASIC_SECRET token=SECRET '/tmp/private path' /usr/private ~/Library/private https://private.example/x"));
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("/tmp/private");
    expect(error.message).not.toContain("/usr/private");
    expect(error.message).not.toContain("~/Library");
    expect(error.message).not.toContain("https://private.example");
  });
  it("preserves a typed service-unavailable reason at the inspect boundary", async () => {
    const ipc = new FakeIpc();
    const reason = "Installed OMP is incompatible; `omp appserver status --json` is required.";
    const { runtime } = makeRuntime(undefined, { code: "omp_incompatible", message: reason });
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const inspection = await ipc.handlers.get("omp:service:inspect")!(event, request("omp:service:inspect"));
    expect(inspection).toEqual({
      definition: "missing",
      service: "unknown",
      diagnostics: "",
      issue: { code: "omp_incompatible", message: reason },
    });
  });
  it("keeps bootstrap read-only and shares one dynamic acquisition across concurrent inspection", async () => {
    const ipc = new FakeIpc();
    let acquisitions = 0;
    let inspections = 0;
    const serviceManager = {
      inspect: async () => {
        inspections += 1;
        return { definition: "current", service: "running", diagnostics: "" };
      },
    } as never as ServiceManager;
    const { runtime: baseRuntime } = makeRuntime();
    const runtime: IpcRuntime = {
      ...baseRuntime,
      getServiceManager: () => undefined,
      acquireServiceManager: async () => {
        acquisitions += 1;
        return serviceManager;
      },
    };
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const bootstrap = await ipc.handlers.get("omp:bootstrap")!(event, request("omp:bootstrap"));
    expect(acquisitions).toBe(0);
    expect((bootstrap as { service: { issue: { code: string } } }).service.issue.code).toBe("service_unavailable");
    const inspect = ipc.handlers.get("omp:service:inspect")!;
    await Promise.all([
      inspect(event, request("omp:service:inspect")),
      inspect(event, request("omp:service:inspect")),
    ]);
    expect(acquisitions).toBe(1);
    expect(inspections).toBe(1);
  });
  it("does not send events to destroyed windows", () => {
    const ipc = new FakeIpc();
    const { runtime, view } = makeRuntime();
    new DesktopIpcRegistry(runtime, ipc).install();
    view.window.isDestroyed = () => true;
    const registry = new DesktopIpcRegistry(runtime, ipc);
    registry.emitPairLink({ hostHint: "host", code: "123456", issuedAt: 1 });
    expect(view.sent).toEqual([]);
  });
});
