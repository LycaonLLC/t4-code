import { describe, expect, it } from "vite-plus/test";

import { parseCompanionHost } from "./backend";

describe("parseCompanionHost", () => {
  it("creates the default Tailnet WebSocket route", () => {
    const host = parseCompanionHost("wolfies-macbook.taild04b86.ts.net:8445");
    expect(host.origin).toBe("https://wolfies-macbook.taild04b86.ts.net:8445");
    expect(host.wsUrl).toBe("wss://wolfies-macbook.taild04b86.ts.net:8445/v1/ws");
    expect(host.profileId).toBe("default");
  });

  it("creates a named-profile route and preserves the device identity", () => {
    const host = parseCompanionHost(
      "https://devbox.example.ts.net:8445",
      "nightly",
      { deviceId: "device-a", deviceToken: "token-a" },
    );
    expect(host.wsUrl).toBe("wss://devbox.example.ts.net:8445/v1/profiles/nightly/ws");
    expect(host.deviceId).toBe("device-a");
    expect(host.deviceToken).toBe("token-a");
  });

  it("rejects public, insecure, and path-bearing addresses", () => {
    expect(() => parseCompanionHost("http://devbox.example.ts.net:8445")).toThrow(/HTTPS/);
    expect(() => parseCompanionHost("https://example.com")).toThrow(/Tailscale/);
    expect(() => parseCompanionHost("https://devbox.example.ts.net:8445/v1/ws")).toThrow(/host address only/);
  });
});
