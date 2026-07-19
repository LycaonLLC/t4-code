import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderTransportReport,
  formatDiagnosticBytes,
  presentProviderTransport,
} from "./provider-transport.ts";

const BASE = {
  provider: "openai-codex" as const,
  configuredPolicy: "auto" as const,
  websocketPreferred: true,
  lastTransport: "websocket" as const,
  websocketDisabled: false,
  websocketConnected: true,
  fallbackCount: 0,
  canAppend: true,
  prewarmed: true,
  hasSessionState: true,
  hasTurnState: true,
  fullContextRequests: 1,
  deltaRequests: 12,
  inputJsonBytes: 64_512,
  lastInputJsonBytes: 2_048,
};

describe("provider transport diagnostics", () => {
  it("presents healthy websocket evidence without exposing raw payloads", () => {
    expect(presentProviderTransport(BASE)).toEqual({
      transport: "WebSocket",
      status: "Connected",
      tone: "good",
      policy: "Automatic",
      reuse: "12 delta · 1 full",
      payload: "63 KB total · 2 KB last",
      connection: "Live socket connected",
    });
  });

  it("makes fallback state visible", () => {
    expect(
      presentProviderTransport({
        ...BASE,
        lastTransport: "sse",
        websocketConnected: false,
        websocketDisabled: true,
        fallbackCount: 2,
        canAppend: false,
      }),
    ).toMatchObject({
      transport: "SSE",
      status: "2 fallbacks",
      tone: "warn",
      connection: "WebSocket disabled after fallback",
    });
  });

  it("does not describe an intentional off policy as a fallback", () => {
    expect(
      presentProviderTransport({
        ...BASE,
        configuredPolicy: "off",
        lastTransport: "sse",
        websocketConnected: false,
        websocketDisabled: true,
        fallbackCount: 0,
      }),
    ).toMatchObject({
      transport: "SSE",
      status: "Streaming",
      tone: "quiet",
      policy: "WebSocket off",
      connection: "WebSocket disabled by policy",
    });
  });

  it("formats bounded request sizes for quick scanning", () => {
    expect(formatDiagnosticBytes(900)).toBe("900 B");
    expect(formatDiagnosticBytes(64_512)).toBe("63 KB");
    expect(formatDiagnosticBytes(2_621_440)).toBe("2.5 MB");
  });

  it("builds a bounded report without session or request content", () => {
    const report = JSON.parse(buildProviderTransportReport(BASE)) as Record<string, unknown>;
    expect(report).toEqual({
      kind: "t4-code.provider-transport",
      version: 1,
      provider: "openai-codex",
      configuredPolicy: "auto",
      lastTransport: "websocket",
      websocketPreferred: true,
      websocketDisabled: false,
      websocketConnected: true,
      fallbackCount: 0,
      canAppend: true,
      prewarmed: true,
      hasSessionState: true,
      hasTurnState: true,
      fullContextRequests: 1,
      deltaRequests: 12,
      inputJsonBytes: 64_512,
      lastInputJsonBytes: 2_048,
    });
    expect(JSON.stringify(report)).not.toMatch(/sessionId|hostId|prompt|credential|token/u);
  });
});
