import { connect as netConnect } from "node:net";
import WebSocket from "ws";

/** Node-only transport used by host integration gates after the desktop client cutover. */
export class UnixWebSocketTransport {
  constructor({ socketPath, handshakeTimeoutMs = 10_000 }) {
    if (!socketPath.startsWith("/")) throw new Error("Unix socket path must be absolute");
    this.socketPath = socketPath;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.messages = new Set();
    this.closes = new Set();
    this.errors = new Set();
    this.socket = undefined;
  }

  open() {
    if (this.socket) return Promise.reject(new Error("local transport is already open"));
    const socket = new WebSocket("ws://t4.local/ws", {
      perMessageDeflate: false,
      maxPayload: 1_048_576,
      handshakeTimeout: this.handshakeTimeoutMs,
      createConnection: () => netConnect({ path: this.socketPath }),
    });
    this.socket = socket;
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error("local transport unavailable"));
      socket.once("open", resolve);
      socket.once("error", fail);
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        for (const listener of this.messages) listener(data.toString());
      });
      socket.on("close", (code, reason) => {
        this.socket = undefined;
        for (const listener of this.closes) listener(code, reason.toString("utf8").slice(0, 256));
      });
      socket.on("error", () => {
        for (const listener of this.errors) listener(new Error("local transport error"));
      });
    });
  }

  send(data) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("local transport is not connected");
    }
    this.socket.send(data);
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client closed");
    this.messages.clear();
    this.closes.clear();
    this.errors.clear();
  }

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener) { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener) { this.errors.add(listener); return () => this.errors.delete(listener); }
}
