import { hostId, type ClientFrame, type ServerFrame, type WelcomeFrame } from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  OmpClient,
  ompAppV1ProtocolProvider,
  type OmpClientMessage,
  type OmpProtocolProvider,
  type OmpTransport,
} from "../src/index.ts";

class HandshakeTransport implements OmpTransport {
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  onMessage(listener: (data: string | Uint8Array) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(): () => void {
    return () => undefined;
  }
  onError(): () => void {
    return () => undefined;
  }
  close(): void {}
  send(data: string): void {
    const frame = ompAppV1ProtocolProvider.decodeClientFrame(data);
    if (frame.type !== "hello") return;
    const welcome: WelcomeFrame = {
      v: "omp-app/1",
      type: "welcome",
      selectedProtocol: "omp-app/1",
      hostId: hostId("provider-host"),
      ompVersion: "test",
      ompBuild: "test",
      appserverVersion: "test",
      appserverBuild: "test",
      epoch: "provider-epoch",
      grantedCapabilities: ["sessions.read"],
      grantedFeatures: ["resume"],
      negotiatedLimits: {},
      authentication: "local",
      resumed: false,
    };
    for (const listener of this.messages) listener(JSON.stringify(welcome));
  }
}

describe("OmpProtocolProvider", () => {
  it("describes the pinned omp-app/1 implementation", () => {
    expect(ompAppV1ProtocolProvider.id).toBe("omp-app-v1");
    expect(ompAppV1ProtocolProvider.protocolVersion).toBe("omp-app/1");
    expect(ompAppV1ProtocolProvider.commandDescriptor("session.list")).toMatchObject({
      capability: "sessions.read",
      scope: "host",
    });
    expect(ompAppV1ProtocolProvider.requiredCapability("session.list")).toBe("sessions.read");
  });

  it("builds every outbound message using the pinned wire shape", () => {
    const messages: OmpClientMessage[] = [
      {
        kind: "hello",
        client: { name: "t4-code", version: "test", build: "test", platform: "electron" },
        requestedFeatures: ["resume"],
        savedCursors: [],
        capabilities: ["sessions.read"],
        authentication: { deviceId: "device", deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      },
      {
        kind: "command",
        requestId: "request-command",
        commandId: "command-command",
        hostId: "provider-host",
        sessionId: "provider-session",
        command: "session.prompt",
        args: { text: "hello" },
      },
      {
        kind: "confirm",
        requestId: "request-confirm",
        confirmationId: "confirmation-fixture",
        commandId: "command-confirm",
        hostId: "provider-host",
        decision: "approve",
      },
      {
        kind: "pair-start",
        requestId: "request-pair",
        code: "123456",
        deviceId: "device",
        deviceName: "test",
        platform: "linux",
        requestedCapabilities: [],
      },
      {
        kind: "terminal-input",
        hostId: "provider-host",
        sessionId: "provider-session",
        terminalId: "terminal-a",
        data: "hello",
      },
      {
        kind: "terminal-resize",
        hostId: "provider-host",
        sessionId: "provider-session",
        terminalId: "terminal-a",
        cols: 80,
        rows: 24,
      },
      {
        kind: "terminal-close",
        hostId: "provider-host",
        sessionId: "provider-session",
        terminalId: "terminal-a",
      },
      { kind: "ping", nonce: "ping-1", timestamp: "2026-07-17T00:00:00.000Z" },
    ];

    const frames = messages.map((message) => ompAppV1ProtocolProvider.buildClientFrame(message));

    expect(frames.map((frame) => frame.type)).toEqual([
      "hello",
      "command",
      "confirm",
      "pair.start",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
      "ping",
    ]);
    const promptFrame = frames[1];
    if (promptFrame?.type !== "command") throw new Error("expected command frame");
    expect(promptFrame).toMatchObject({ v: "omp-app/1", type: "command" });
    expect(promptFrame.args).toEqual({ message: "hello" });
    const normalized = ompAppV1ProtocolProvider.buildClientFrame({
      kind: "command",
      requestId: "request-legacy",
      commandId: "command-legacy",
      hostId: "provider-host",
      sessionId: "provider-session",
      command: "session.prompt",
      args: { prompt: "legacy" },
    });
    if (normalized.type !== "command") throw new Error("expected command frame");
    expect(normalized.args).toEqual({ message: "legacy" });
    expect(() =>
      ompAppV1ProtocolProvider.buildClientFrame({
        kind: "command",
        requestId: "request-empty",
        commandId: "command-empty",
        hostId: "provider-host",
        sessionId: "provider-session",
        command: "session.prompt",
        args: {},
      }),
    ).toThrow();
    for (const frame of frames) {
      expect(JSON.parse(ompAppV1ProtocolProvider.encodeClientFrame(frame))).toEqual(frame);
    }
  });

  it("routes outbound building, encoding, and server decoding through an injected provider", async () => {
    let clientBuilds = 0;
    let clientEncodes = 0;
    let serverDecodes = 0;
    const provider: OmpProtocolProvider = {
      ...ompAppV1ProtocolProvider,
      buildClientFrame(message: OmpClientMessage): ClientFrame {
        clientBuilds += 1;
        return ompAppV1ProtocolProvider.buildClientFrame(message);
      },
      encodeClientFrame(frame: ClientFrame): string {
        clientEncodes += 1;
        return ompAppV1ProtocolProvider.encodeClientFrame(frame);
      },
      decodeServerFrame(input: unknown): ServerFrame {
        serverDecodes += 1;
        return ompAppV1ProtocolProvider.decodeServerFrame(input);
      },
    };
    const client = new OmpClient({
      hostId: "provider-host",
      protocolProvider: provider,
      transport: () => new HandshakeTransport(),
    });

    await client.connect();

    expect(client.state).toBe("ready");
    expect(clientBuilds).toBeGreaterThan(0);
    expect(clientEncodes).toBeGreaterThan(0);
    expect(serverDecodes).toBe(1);
    await client.close();
  });
});
