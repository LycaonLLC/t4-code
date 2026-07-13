import { describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { FixtureWebSocketServer } from "@t4-code/fixture-server";
import { OmpClient, ProjectionStore, type OmpTransport, type Unsubscribe } from "../src/index.ts";

class WebSocketTransport implements OmpTransport {
  private readonly socket: WebSocket;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  constructor(address: string) { this.socket = new WebSocket(address); this.socket.on("message", (data) => { for (const listener of this.messages) listener(data as Uint8Array); }); this.socket.on("close", (code, reason) => { for (const listener of this.closes) listener(code, reason.toString()); }); this.socket.on("error", (error) => { for (const listener of this.errors) listener(error); }); }
  async opened(): Promise<void> { if (this.socket.readyState === WebSocket.OPEN) return; const { promise, resolve, reject } = Promise.withResolvers<void>(); this.socket.once("open", resolve); this.socket.once("error", reject); return promise; }
  send(data: string): void { this.socket.send(data); }
  close(): void { this.socket.close(); }
  onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (code?: number, reason?: string) => void): Unsubscribe { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): Unsubscribe { this.errors.add(listener); return () => this.errors.delete(listener); }
}


async function yieldLoop(): Promise<void> { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); return promise; }
describe("OmpClient and FixtureWebSocketServer projection boundary", () => {
  it("handshakes and feeds real FixtureWebSocketServer frames into projection", async () => {
    const server = new FixtureWebSocketServer({ scenario: "stream-v1" });
    await server.start();
    const projection = new ProjectionStore();
    let currentTransport: WebSocketTransport | undefined;
    const client = new OmpClient({ hostId: "host-stream", projection, reconnect: { baseMs: 5, maxMs: 20, attemptCap: 2 }, transport: async () => { currentTransport = new WebSocketTransport(server.address); await currentTransport.opened(); return currentTransport; } });
    try {
      await client.connect();
      await client.attach("host-stream", "session-stream");
      const key = "host-stream\u0000session-stream";
      expect(projection.snapshot.sessions.has(key)).toBe(true);
      expect(projection.snapshot.sessions.get(key)!.entries).toHaveLength(1);
      const { promise: streamed, resolve: resolveStreamed } = Promise.withResolvers<void>();
      const disposeStream = projection.subscribe((snapshot) => {
        const updates = snapshot.sessions
          .get(key)
          ?.events.filter((event) => event.event.type === "message.update").length;
        if ((updates ?? 0) >= 2) resolveStreamed();
      });
      const prompt = client.command({ hostId: "host-stream", sessionId: "session-stream", command: "session.prompt", args: { message: "hello" } });
      await yieldLoop();
      await prompt;
      server.advanceBy(40);
      await yieldLoop();
      await streamed;
      disposeStream();
      // The subscription above proves both live events crossed the real
      // WebSocket boundary. Once the matching durable entry arrives, the
      // projection must retire those transient frames so the response cannot
      // render twice.
      expect(
        projection.snapshot.sessions.get(key)!.events.map((event) => event.event.type),
      ).toEqual(["agent.start", "turn.start", "turn.end", "agent.end"]);
      expect(projection.snapshot.sessions.get(key)!.entries).toHaveLength(2);
      expect(JSON.stringify(projection.snapshot)).not.toContain("deviceToken");
      const { promise: reconnected, resolve: resolveReconnect } = Promise.withResolvers<void>();
      const disposeReconnect = client.onState((state) => { if (state.state === "ready") resolveReconnect(); });
      currentTransport?.close();
      await reconnected;
      disposeReconnect();
    } finally {
      await client.close();
      await server.stop();
    }
  });
});
