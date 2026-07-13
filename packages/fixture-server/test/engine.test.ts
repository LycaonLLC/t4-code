import { describe, expect, it } from "vite-plus/test";
import { decodeServerFrame } from "@t4-code/protocol";
import { FixtureEngine } from "../src/engine.ts";
import { loadScenario, type ScenarioSeed } from "../src/seeds.ts";

const hello = (savedCursors: unknown[] = []) => ({
  v: "omp-app/1",
  type: "hello",
  protocol: { min: "omp-app/1", max: "omp-app/1" },
  client: { name: "fixture-test", version: "1", build: "test", platform: "linux" },
  requestedFeatures: ["resume"],
  savedCursors,
});
const command = (
  seed: ScenarioSeed,
  commandName: string,
  commandId: string,
  requestId = commandId,
  providedArgs: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => {
  const hostCommand = ["host.list", "session.list", "session.create", "audit.read", "audit.tail", "config.write", "settings.read", "settings.write", "catalog.get", "host.watch"].includes(commandName);
  const args = commandName === "session.prompt" && !("message" in providedArgs) ? { message: "fixture prompt", ...providedArgs } : providedArgs;
  return {
    v: "omp-app/1",
    type: "command",
    requestId,
    commandId,
    hostId: seed.hostId,
    ...(hostCommand ? {} : { sessionId: seed.sessionId }),
    command: commandName,
    args,
    ...extra,
  };
};

function ready(engine: FixtureEngine, id: string): void {
  engine.receive(id, hello());
  engine.receive(id, command(engine.seed, "session.attach", `attach-${id}`));
}

describe("deterministic fixture engine", () => {
  it("decodes every handshake, snapshot, list, and ping frame for all ten seeds", () => {
    for (const scenario of [
      "basic-v1",
      "stream-v1",
      "hierarchy-v1",
      "history-10k-v1",
      "faults-v1",
      "multi-client-v1",
      "remote-v1",
      "a11y-v1",
      "reconnect-v1",
      "preview-v1",
    ] as const) {
      const engine = new FixtureEngine(loadScenario(scenario));
      const client = engine.connect("a");
      const handshake = engine.receive(client.id, hello());
      expect(handshake).toHaveLength(3);
      for (const frame of handshake) expect(() => decodeServerFrame(frame)).not.toThrow();
      const ping = engine.receive(client.id, {
        v: "omp-app/1",
        type: "ping",
        nonce: "n-1",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(ping[0]?.type).toBe("pong");
      expect(() => decodeServerFrame(ping[0])).not.toThrow();
      const list = engine.receive(client.id, command(engine.seed, "session.list", "c-list"));
      expect(list[0]?.type).toBe("response");
      expect(() => decodeServerFrame(list[0])).not.toThrow();
    }
  });
  it("requires hello, enforces exact host, and rejects a second hello", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    expect(engine.receive(client.id, command(engine.seed, "host.list", "before"))[0]).toMatchObject(
      { type: "error", code: "HELLO_REQUIRED" },
    );
    engine.receive(client.id, hello());
    expect(engine.receive(client.id, hello())[0]).toMatchObject({
      type: "error",
      code: "INVALID_FRAME",
    });
    const wrongHost = {
      ...command(engine.seed, "session.list", "wrong-host"),
      hostId: "other-host",
    };
    expect(engine.receive(client.id, wrongHost)[0]).toMatchObject({
      type: "response",
      ok: false,
      error: { code: "not_found" },
    });
  });
  it("broadcasts only to attached clients and keeps the stream contiguous", () => {
    const engine = new FixtureEngine(loadScenario("stream-v1"));
    const a = engine.connect("a");
    const b = engine.connect("b");
    engine.receive(a.id, hello());
    engine.receive(b.id, hello());
    engine.receive(a.id, command(engine.seed, "session.attach", "attach-a"));
    engine.receive(a.id, command(engine.seed, "session.prompt", "prompt-a"));
    engine.advanceBy(30);
    const aFrames = engine.drain(a.id);
    const bFrames = engine.drain(b.id);
    expect(aFrames.map((frame) => frame.type)).toEqual([
      "event",
      "event",
      "event",
      "event",
      "event",
      "entry",
      "event",
      "event",
    ]);
    expect(bFrames).toHaveLength(0);
    expect(
      aFrames.map((frame) =>
        frame.type === "event" || frame.type === "entry" ? frame.cursor.seq : -1,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      aFrames.map((frame) => (frame.type === "event" ? frame.event.type : frame.type)),
    ).toEqual([
      "agent.start",
      "turn.start",
      "message.update",
      "message.update",
      "message.settled",
      "entry",
      "turn.end",
      "agent.end",
    ]);
    const first = aFrames[2];
    const second = aFrames[3];
    const settlement = aFrames[4];
    const settled = aFrames[5];
    expect(first).toMatchObject({
      type: "event",
      event: { type: "message.update", text: "Hello" },
    });
    expect(second).toMatchObject({
      type: "event",
      event: { type: "message.update", text: "Hello world" },
    });
    if (
      first?.type !== "event" ||
      second?.type !== "event" ||
      settlement?.type !== "event" ||
      settled?.type !== "entry"
    ) {
      throw new Error("stream fixture emitted an unexpected frame family");
    }
    expect(second.event.entryId).toBe(first.event.entryId);
    expect(settlement.event).toMatchObject({
      type: "message.settled",
      transientEntryId: first.event.entryId,
      entryId: settled.entry.id,
    });
    expect(settled.entry.id).not.toBe(first.event.entryId);
    expect(engine.currentRevision).not.toBe(engine.seed.revision);

    const reloaded = engine.connect("reloaded");
    const reloadFrames = engine.receive(reloaded.id, hello());
    const reloadSnapshot = reloadFrames.find((frame) => frame.type === "snapshot");
    if (reloadSnapshot?.type !== "snapshot") throw new Error("reload did not receive a snapshot");
    expect(reloadSnapshot.entries.filter((entry) => entry.id === settled.entry.id)).toEqual([
      settled.entry,
    ]);
  });
  it("replays exact retained frames and uses gap plus snapshot after epoch change", () => {
    const engine = new FixtureEngine(loadScenario("stream-v1"));
    const a = engine.connect("a");
    engine.receive(a.id, hello());
    engine.receive(a.id, command(engine.seed, "session.attach", "attach-a"));
    engine.receive(a.id, command(engine.seed, "session.prompt", "prompt-a"));
    engine.advanceBy(30);
    const original = engine.drain(a.id);
    const b = engine.connect("b");
    engine.receive(b.id, hello());
    const replay = engine.receive(
      b.id,
      command(engine.seed, "session.attach", "attach-b", "attach-b", {
        cursor: { epoch: engine.seed.epoch, seq: 0 },
      }),
    );
    const replayFrames = replay.filter((frame) => frame.type === "event" || frame.type === "entry");
    expect(replayFrames).toEqual(
      original.filter((frame) => frame.type === "event" || frame.type === "entry"),
    );
    engine.restart("epoch-stream-2");
    const c = engine.connect("c");
    engine.receive(c.id, hello());
    const recovered = engine.receive(
      c.id,
      command(engine.seed, "session.attach", "attach-c", "attach-c", {
        cursor: { epoch: engine.seed.epoch, seq: 3 },
      }),
    );
    expect(recovered.map((frame) => frame.type)).toContain("gap");
    expect(recovered.map((frame) => frame.type)).toContain("snapshot");
    for (const frame of recovered) expect(() => decodeServerFrame(frame)).not.toThrow();
  });
  it("makes command IDs idempotent and reports payload conflicts", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);
    const first = engine.receive(
      client.id,
      command(engine.seed, "session.prompt", "same", "first", { message: "one" }),
    );
    const second = engine.receive(
      client.id,
      command(engine.seed, "session.prompt", "same", "second", { message: "one" }),
    );
    expect(second[0]).toEqual(first[0]);
    expect(
      engine.receive(
        client.id,
        command(engine.seed, "session.prompt", "same", "third", { message: "two" }),
      )[0],
    ).toMatchObject({ type: "response", ok: false, error: { code: "idempotency_conflict" } });
  });
  it("mirrors OMP confirmation correlation for approve, deny, and invalid decisions", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);

    const cancel = command(
      engine.seed,
      "session.cancel",
      "cancel-command",
      "cancel-request",
    );
    const challenge = engine.receive(client.id, cancel)[0];
    expect(challenge).toMatchObject({
      type: "confirmation",
      commandId: "cancel-command",
      summary: "session.cancel",
    });
    if (challenge?.type !== "confirmation") throw new Error("fixture did not challenge cancel");
    const approved = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "confirm-request",
      confirmationId: challenge.confirmationId,
      commandId: challenge.commandId,
      hostId: challenge.hostId,
      sessionId: challenge.sessionId,
      decision: "approve",
    })[0];
    expect(approved).toMatchObject({
      type: "response",
      requestId: "cancel-request",
      commandId: "cancel-command",
      command: "session.cancel",
      ok: true,
    });

    const deniedCommand = command(
      engine.seed,
      "session.cancel",
      "deny-command",
      "deny-request",
    );
    const deniedChallenge = engine.receive(client.id, deniedCommand)[0];
    if (deniedChallenge?.type !== "confirmation") throw new Error("fixture did not challenge deny");
    const denied = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "deny-confirm-request",
      confirmationId: deniedChallenge.confirmationId,
      commandId: deniedChallenge.commandId,
      hostId: deniedChallenge.hostId,
      sessionId: deniedChallenge.sessionId,
      decision: "deny",
    })[0];
    expect(denied).toMatchObject({
      type: "response",
      requestId: "deny-request",
      ok: false,
      error: { code: "confirmation_denied" },
    });

    const invalid = engine.receive(client.id, {
      v: "omp-app/1",
      type: "confirm",
      requestId: "replayed-confirm-request",
      confirmationId: deniedChallenge.confirmationId,
      commandId: deniedChallenge.commandId,
      hostId: deniedChallenge.hostId,
      sessionId: deniedChallenge.sessionId,
      decision: "approve",
    })[0];
    expect(invalid).toMatchObject({
      type: "response",
      requestId: "replayed-confirm-request",
      ok: false,
      error: { code: "confirmation_invalid" },
    });
  });
  it("closes a client at the bounded queue and deletes disconnected clients", () => {
    const base = loadScenario("basic-v1");
    const seed: ScenarioSeed = {
      ...base,
      scripts: {
        ...base.scripts,
        prompt: Array.from({ length: 200 }, (_, i) => ({
          atMs: 0,
          kind: "event" as const,
          text: `e-${i}`,
        })),
      },
    };
    const engine = new FixtureEngine(seed);
    const client = engine.connect("a");
    ready(engine, client.id);
    engine.receive(client.id, command(seed, "session.prompt", "flood"));
    engine.advanceBy(0);
    expect(engine.inspect(client.id).closed).toBe(true);
    engine.disconnect(client.id);
    expect(engine.clientCount).toBe(0);
  });
  it("emits decodable 0.2 additive watch, lease, agent, file, audit, catalog, settings, preview, and terminal frames", () => {
    const engine = new FixtureEngine(loadScenario("basic-v1"));
    const client = engine.connect("a");
    ready(engine, client.id);
    const commands: Array<[string, Record<string, unknown>]> = [
      ["host.watch", {}],
      ["session.watch", {}],
      ["controller.lease.acquire", { ownerId: "fixture-device" }],
      ["prompt.lease.acquire", { ownerId: "fixture-device" }],
      ["agent.cancel", { agentId: "agent-fixture" }],
      ["files.list", {}],
      ["files.diff", { path: "src/file.ts" }],
      ["audit.tail", {}],
      ["catalog.get", {}],
      ["settings.read", {}],
      ["preview.launch", { url: "http://127.0.0.1/fixture" }],
      ["preview.state", {}],
      ["preview.navigate", { url: "http://127.0.0.1/fixture" }],
      ["preview.capture", {}],
    ];
    for (const [name, args] of commands) {
      const frames = engine.receive(client.id, command(engine.seed, name, name, name, args));
      for (const frame of frames) expect(() => decodeServerFrame(frame)).not.toThrow();
    }
    const terminalOutput = engine.receive(client.id, {
      v: "omp-app/1",
      type: "terminal.input",
      hostId: engine.seed.hostId,
      sessionId: engine.seed.sessionId,
      terminalId: "terminal-fixture",
      data: "hi",
    });
    const terminalExit = engine.receive(client.id, {
      v: "omp-app/1",
      type: "terminal.close",
      hostId: engine.seed.hostId,
      sessionId: engine.seed.sessionId,
      terminalId: "terminal-fixture",
    });
    for (const frame of [...terminalOutput, ...terminalExit]) expect(() => decodeServerFrame(frame)).not.toThrow();
  });
  it("is deterministic across two identical runs", () => {
    const run = () => {
      const engine = new FixtureEngine(loadScenario("stream-v1"));
      const client = engine.connect("a");
      ready(engine, client.id);
      engine.receive(client.id, command(engine.seed, "session.prompt", "prompt"));
      engine.advanceBy(30);
      engine.drain(client.id);
      return {
        hash: engine.stateHash,
        frames: engine.journalSize,
        revision: engine.currentRevision,
      };
    };
    expect(run()).toEqual(run());
  });
});
