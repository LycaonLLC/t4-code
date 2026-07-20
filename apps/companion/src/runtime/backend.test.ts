import { describe, expect, it } from "vite-plus/test";

import { parseCompanionHost } from "./backend";

describe("parseCompanionHost", () => {
  it("creates the default Tailnet WebSocket route", () => {
    const host = parseCompanionHost("mac.example.ts.net:8445");
    expect(host.origin).toBe("https://mac.example.ts.net:8445");
    expect(host.wsUrl).toBe("wss://mac.example.ts.net:8445/v1/ws");
    expect(host.profileId).toBe("default");
  });

  it("creates a named-profile route and preserves the device identity", () => {
    const host = parseCompanionHost(
      "https://devbox.example.ts.net:8445",
      "nightly",
      {
        endpointKey: "https://devbox.example.ts.net:8445#profile=nightly",
        deviceId: "device-a",
        deviceToken: "token-a",
      },
    );
    expect(host.wsUrl).toBe("wss://devbox.example.ts.net:8445/v1/profiles/nightly/ws");
    expect(host.deviceId).toBe("device-a");
    expect(host.deviceToken).toBe("token-a");
  });

  it("does not send one host's credential to another host or profile", () => {
    const existing = {
      endpointKey: "https://devbox.example.ts.net:8445#profile=default",
      deviceId: "device-a",
      deviceToken: "token-a",
    };
    const otherHost = parseCompanionHost("https://other.example.ts.net:8445", "default", existing);
    const otherProfile = parseCompanionHost("https://devbox.example.ts.net:8445", "nightly", existing);

    expect(otherHost.deviceId).toBe("device-a");
    expect(otherHost.deviceToken).toBeUndefined();
    expect(otherProfile.deviceToken).toBeUndefined();
  });

  it("rejects public, insecure, and path-bearing addresses", () => {
    expect(() => parseCompanionHost("http://devbox.example.ts.net:8445")).toThrow(/HTTPS/);
    expect(() => parseCompanionHost("https://example.com")).toThrow(/Tailscale/);
    expect(() => parseCompanionHost("https://devbox.example.ts.net:8445/v1/ws")).toThrow(/host address only/);
  });
});
