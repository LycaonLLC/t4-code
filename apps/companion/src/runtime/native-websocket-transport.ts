import { Platform } from "react-native";

import type { OmpTransport, Unsubscribe } from "@t4-code/client";
import { nativeWebSocketOrigin } from "./native-websocket-origin";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 12_000;

type NativeWebSocketConstructor = new (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string> },
) => WebSocket;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class NativeWebSocketTransport implements OmpTransport {
  private socket: WebSocket | undefined;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();

  constructor(private readonly url: string) {}

  open(): Promise<void> {
    if (this.socket !== undefined) return Promise.reject(new Error("connection already started"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket =
        Platform.OS === "web"
          ? new WebSocket(this.url)
          : new (WebSocket as unknown as NativeWebSocketConstructor)(this.url, [], {
              headers: { origin: nativeWebSocketOrigin(this.url) },
            });
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("T4 did not answer in time."));
        socket.close();
      }, OPEN_TIMEOUT_MS);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      socket.onmessage = (event) => {
        const data = event.data;
        if (typeof data === "string") {
          if (byteLength(data) > MAX_MESSAGE_BYTES) return this.fail("T4 sent a message that was too large.");
          for (const listener of this.messages) listener(data);
        } else if (data instanceof ArrayBuffer) {
          if (data.byteLength > MAX_MESSAGE_BYTES) return this.fail("T4 sent a message that was too large.");
          for (const listener of this.messages) listener(new Uint8Array(data));
        }
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("The secure connection to T4 failed."));
        }
        this.fail("The secure connection to T4 failed.");
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        this.socket = undefined;
        if (!settled) {
          settled = true;
          reject(new Error("T4 closed the connection before it was ready."));
        }
        for (const listener of this.closes) listener(event.code, event.reason.slice(0, 256));
      };
    });
  }

  send(data: string): void {
    if (byteLength(data) > MAX_MESSAGE_BYTES) throw new Error("outgoing message is too large");
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("T4 is not connected");
    this.socket.send(data);
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) socket.close(1000, "client closed");
  }

  onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onClose(listener: (code?: number, reason?: string) => void): Unsubscribe {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  onError(listener: (error: unknown) => void): Unsubscribe {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  private fail(message: string): void {
    const error = new Error(message);
    for (const listener of this.errors) listener(error);
  }
}
