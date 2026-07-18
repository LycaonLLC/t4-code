import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  FixtureWebSocketServer,
  SCENARIO_IDS,
  type ScenarioId,
} from "../packages/fixture-server/src/index.ts";

function selectedScenario(value: string | undefined): ScenarioId {
  if (value === undefined) return "stream-v1";
  const scenario = SCENARIO_IDS.find((candidate) => candidate === value);
  if (scenario === undefined) throw new Error(`unknown fixture scenario: ${value}`);
  return scenario;
}

const scenario = selectedScenario(process.env.T4_FIXTURE_SCENARIO);
const fixture = new FixtureWebSocketServer({ scenario });
const wsUrl = await fixture.start();

const control = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method === "POST" && url.pathname === "/advance") {
    const ms = Number(url.searchParams.get("ms"));
    if (!Number.isSafeInteger(ms) || ms < 0) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid virtual time increment" }));
      return;
    }
    fixture.advanceBy(ms);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, nowMs: fixture.engine.virtualTime }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/state") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
    response.end(
      JSON.stringify({
        scenario,
        sessions: fixture.engine.sessions,
        clients: fixture.clientCount,
        connections: fixture.connectionCount,
      }),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/disconnect") {
    fixture.dropConnections();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise<void>((resolveStart, reject) => {
  control.once("error", reject);
  control.listen(0, "127.0.0.1", () => resolveStart());
});

const controlPort = (control.address() as AddressInfo).port;
process.stdout.write(
  `T4_FIXTURE_READY ${JSON.stringify({ wsUrl, controlUrl: `http://127.0.0.1:${controlPort}` })}\n`,
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolveStop) => control.close(() => resolveStop()));
  await fixture.stop();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}
