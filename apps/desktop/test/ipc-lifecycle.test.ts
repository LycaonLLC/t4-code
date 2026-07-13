import { describe, expect, it } from "vitest";
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
function makeRuntime(serviceManager?: ServiceManager, serviceUnavailableReason?: string) {
  const view = fakeWindow();
  const manager = { isConnected: () => true, connect: async () => "connected", disconnect: async () => {}, command: async () => ({ targetId: "local", requestId: "1", commandId: "1", accepted: true }), pairStart: async () => ({ targetId: "remote", paired: true }), listTargets: async () => [], addRemoteTarget: async (target: unknown) => target, removeTarget: async () => {} };
  return { view, runtime: { manager, window: view.window, trustedRenderer: { origin: "file://", url: "file:///trusted/index.html" }, ...(serviceManager === undefined ? {} : { serviceManager }), ...(serviceUnavailableReason === undefined ? {} : { serviceUnavailableReason }) } as unknown as IpcRuntime };
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
    expect(order).toEqual(["start"]);
    release();
    await Promise.all([start, stop]);
    expect(order).toEqual(["start", "stop"]);
  });
  it("bounds service inspection and redacts diagnostic details", async () => {
    const ipc = new FakeIpc();
    const serviceManager = { inspect: async () => ({ definition: "drifted", service: "failed", diagnostics: `token=SECRET https://private.example/x /home/private/file ${"x".repeat(1000)}` }) } as never as ServiceManager;
    const { runtime } = makeRuntime(serviceManager);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const result = await ipc.handlers.get("omp:service:inspect")!(event, request("omp:service:inspect"));
    const inspection = result as { diagnostics: string };
    expect(inspection.diagnostics.length).toBeLessThanOrEqual(512);
    expect(inspection.diagnostics).not.toContain("SECRET");
    expect(inspection.diagnostics).not.toContain("/home/private");
    const error = runtimeError(new Error("failed token=SECRET /tmp/private https://private.example/x"));
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("/tmp/private");
    expect(error.message).not.toContain("https://private.example");
  });
  it("preserves a safe service-unavailable reason at the inspect boundary", async () => {
    const ipc = new FakeIpc();
    const reason = "Installed OMP is incompatible; `omp appserver status --json` is required.";
    const { runtime } = makeRuntime(undefined, reason);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    await expect(
      ipc.handlers.get("omp:service:inspect")!(event, request("omp:service:inspect")),
    ).rejects.toThrow(reason);
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
