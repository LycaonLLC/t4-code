import { describe, expect, it } from "vite-plus/test";

import { nativeWebSocketOrigin } from "./native-websocket-origin";

describe("nativeWebSocketOrigin", () => {
  it("maps the secure socket endpoint to its exact HTTPS Origin", () => {
    expect(nativeWebSocketOrigin("wss://workstation.example-tailnet.ts.net:8445/v1/ws")).toBe(
      "https://workstation.example-tailnet.ts.net:8445",
    );
  });

  it("rejects plaintext native transports", () => {
    expect(() => nativeWebSocketOrigin("ws://workstation.example-tailnet.ts.net:8445/v1/ws")).toThrow(
      "native T4 connections require WSS",
    );
  });
});
