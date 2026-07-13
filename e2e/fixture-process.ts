import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { FixtureWebSocketServer } from "../packages/fixture-server/src/index.ts";

const fixture = new FixtureWebSocketServer({ scenario: "stream-v1" });
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
