import { hostId, type ClientFrame, type ServerFrame, type WelcomeFrame } from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  OmpClient,
  ompAppV1ProtocolProvider,
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

  it("routes client and server decoding through an injected provider", async () => {
    let clientDecodes = 0;
    let serverDecodes = 0;
    const provider: OmpProtocolProvider = {
      ...ompAppV1ProtocolProvider,
      decodeClientFrame(input: unknown): ClientFrame {
        clientDecodes += 1;
        return ompAppV1ProtocolProvider.decodeClientFrame(input);
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
    expect(clientDecodes).toBeGreaterThan(0);
    expect(serverDecodes).toBe(1);
    await client.close();
  });
});
