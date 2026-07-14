import { describe, expect, it } from "vite-plus/test";
import {
  commandResultError,
  decodeDesktopEvent,
  decodeDesktopInvokeRequest,
  isDesktopInvokeRequest,
} from "../src/desktop-ipc.ts";

describe("desktop IPC boundary", () => {
  it("keeps bounded actionable command errors while redacting secret-shaped details", () => {
    const error = commandResultError({
      code: "stale_revision",
      message: "Session changed\nrefresh first; Bearer live-message-token",
      details: {
        expectedRevision: "revision-1",
        actualRevision: "revision-2",
        diagnostic: "token=live-detail-token",
        accessToken: "must-not-cross-ipc",
      },
    });
    expect(error).toEqual({
      code: "stale_revision",
      message: "Session changed refresh first; [redacted]",
      details: {
        expectedRevision: "revision-1",
        actualRevision: "revision-2",
        diagnostic: "token=[redacted]",
      },
    });
  });
  it("bounds oversized child-failure details without losing the failure category", () => {
    const error = commandResultError({
      code: "outcome_unknown",
      message: "rpc child emitted an oversized agent_end frame",
      details: {
        diagnostic: "x".repeat(32_000),
        nested: Array.from({ length: 100 }, (_, index) => ({ index, value: "y".repeat(2_000) })),
      },
    });
    expect(error).toBeDefined();
    if (error === undefined) throw new Error("command error was not preserved");
    expect(error.code).toBe("outcome_unknown");
    expect(error.message).toContain("oversized agent_end");
    expect(error.details).toBeDefined();
    if (error.details === undefined) throw new Error("command error details were not preserved");
    expect(JSON.stringify(error.details).length).toBeLessThan(8_192);
    const diagnostic = error.details.diagnostic;
    expect(typeof diagnostic).toBe("string");
    if (typeof diagnostic !== "string") throw new Error("bounded diagnostic was not preserved");
    expect(diagnostic.length).toBeLessThanOrEqual(1_024);
  });
  it("decodes bootstrap, target, pair and command intents", () => {
    expect(decodeDesktopInvokeRequest({ channel: "omp:bootstrap", payload: {} })).toEqual({
      channel: "omp:bootstrap",
      payload: {},
    });
    expect(
      decodeDesktopInvokeRequest({ channel: "omp:connect", payload: { targetId: "remote-1" } }),
    ).toEqual({ channel: "omp:connect", payload: { targetId: "remote-1" } });
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:pair",
        payload: { targetId: "remote-1", code: "123456" },
      }),
    ).toBeTruthy();
    const command = decodeDesktopInvokeRequest({
      channel: "omp:command",
      payload: { targetId: "remote-1", intent: { hostId: "h", command: "host.list", args: {} } },
    });
    expect(command).toMatchObject({
      channel: "omp:command",
      payload: { intent: { hostId: "h", command: "host.list", args: {} } },
    });
  });
  it("decodes confirmations and target-scoped terminal requests with app-wire bounds", () => {
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:confirm",
        payload: {
          targetId: "remote-1",
          confirmationId: "confirm-1",
          commandId: "command-1",
          hostId: "host-1",
          sessionId: "session-1",
          decision: "approve",
        },
      }),
    ).toMatchObject({
      channel: "omp:confirm",
      payload: { targetId: "remote-1", decision: "approve" },
    });
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:terminal:resize",
        payload: {
          targetId: "remote-1",
          hostId: "host-1",
          sessionId: "session-1",
          terminalId: "term-1",
          cols: 80,
          rows: 24,
        },
      }),
    ).toMatchObject({ payload: { cols: 80, rows: 24 } });
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:terminal:input",
        payload: {
          targetId: "remote-1",
          hostId: "host-1",
          sessionId: "session-1",
          terminalId: "term-1",
          data: "hi",
          encoding: "utf8",
        },
      }),
    ).toBeTruthy();
    for (const value of [
      {
        channel: "omp:confirm",
        payload: {
          targetId: "remote-1",
          confirmationId: "c",
          commandId: "x",
          hostId: "h",
          decision: "approve",
          token: "secret",
        },
      },
      {
        channel: "omp:terminal:resize",
        payload: {
          targetId: "remote-1",
          hostId: "h",
          sessionId: "s",
          terminalId: "t",
          cols: 1001,
          rows: 24,
        },
      },
      {
        channel: "omp:terminal:input",
        payload: {
          targetId: "remote-1",
          hostId: "h",
          sessionId: "s",
          terminalId: "t",
          data: "%%%%",
          encoding: "base64",
        },
      },
    ])
      expect(() => decodeDesktopInvokeRequest(value)).toThrow();
  });
  it("carries planned session management commands and results across strict desktop IPC", () => {
    const request = decodeDesktopInvokeRequest({
      channel: "omp:command",
      payload: {
        targetId: "remote-1",
        intent: {
          hostId: "host-1",
          sessionId: "session-1",
          command: "session.archive",
          expectedRevision: "revision-1",
          args: {},
        },
      },
    });
    expect(request).toMatchObject({
      channel: "omp:command",
      payload: {
        targetId: "remote-1",
        intent: { command: "session.archive", expectedRevision: "revision-1" },
      },
    });
    expect(
      decodeDesktopEvent({
        channel: "omp:server-frame",
        payload: {
          targetId: "remote-1",
          frame: {
            v: "omp-app/1",
            type: "response",
            requestId: "request-1",
            commandId: "command-1",
            command: "session.archive",
            hostId: "host-1",
            sessionId: "session-1",
            ok: true,
            result: { archived: true },
          },
        },
      }),
    ).toMatchObject({
      payload: { frame: { command: "session.archive", ok: true, result: { archived: true } } },
    });
  });
  it("decodes events and rejects hostile shapes", () => {
    expect(
      decodeDesktopEvent({
        channel: "omp:connection-state",
        payload: { targetId: "x", state: "connected" },
      }),
    ).toBeTruthy();
    expect(
      decodeDesktopEvent({
        channel: "omp:runtime-error",
        payload: { code: "transport", message: "failed" },
      }),
    ).toBeTruthy();
    expect(
      decodeDesktopEvent({
        channel: "omp:server-frame",
        payload: {
          targetId: "target-1",
          frame: {
            v: "omp-app/1",
            type: "welcome",
            selectedProtocol: "omp-app/1",
            hostId: "host-1",
            ompVersion: "16.4.3",
            ompBuild: "test",
            appserverVersion: "0.1.0",
            appserverBuild: "test",
            epoch: "epoch-1",
            grantedCapabilities: [],
            grantedFeatures: [],
            negotiatedLimits: {},
            authentication: "local",
            resumed: false,
          },
        },
      }),
    ).toMatchObject({
      payload: { targetId: "target-1", frame: { type: "welcome", hostId: "host-1" } },
    });
    expect(() =>
      decodeDesktopEvent({
        channel: "omp:server-frame",
        payload: {
          targetId: "target-1",
          frame: {
            v: "omp-app/1",
            type: "pair.ok",
            requestId: "request-1",
            pairingId: "pairing-1",
            deviceId: "device-1",
            deviceName: "Workstation",
            platform: "linux",
            requestedCapabilities: ["sessions.read"],
            grantedCapabilities: ["sessions.read"],
            deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            expiresAt: "2026-07-11T12:00:00.000Z",
          },
        },
      }),
    ).toThrow("pair credentials cannot cross renderer IPC");
    for (const value of [
      { channel: "other", payload: {} },
      { channel: "connect", payload: { targetId: "x" } },
      { channel: "omp:connect", payload: { targetId: "bad target" } },
      { channel: "omp:bootstrap", payload: { platform: "linux" } },
      { channel: "omp:pair", payload: { targetId: "x", code: "12345" } },
      {
        channel: "omp:command",
        payload: {
          targetId: "x",
          intent: { hostId: "h", command: "host.list", args: {}, token: "x" },
        },
      },
    ])
      expect(isDesktopInvokeRequest(value)).toBe(false);
  });
});
