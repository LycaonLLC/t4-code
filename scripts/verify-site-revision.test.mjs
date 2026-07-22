import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSiteRevision,
  revisionUrl,
  waitForSiteRevision,
} from "./verify-site-revision.mjs";

const expected = "a".repeat(40);
const stale = "b".repeat(40);

function revisionResponse(revision, options = {}) {
  return new Response(JSON.stringify({ revision }), {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/json" },
  });
}

test("public verification is pinned to the HTTPS t4code.com revision endpoint", async () => {
  assert.equal(revisionUrl("public"), "https://t4code.com/revision.json");
  assert.equal(revisionUrl("origin"), "https://t4-site.tailb18de3.ts.net/revision.json");
  assert.throws(() => revisionUrl("https://attacker.example/revision.json"), /public or origin/u);

  const requests = [];
  const revision = await fetchSiteRevision({
    target: "public",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return revisionResponse(expected);
    },
  });
  assert.equal(revision, expected);
  assert.deepEqual(requests.map(({ url }) => url), ["https://t4code.com/revision.json"]);
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.cache, "no-store");
});

test("waiter retries stale and unavailable revisions until the exact SHA is public", async () => {
  let clock = 0;
  const logs = [];
  const responses = [
    new Response("unavailable", { status: 503 }),
    revisionResponse(stale),
    revisionResponse(expected),
  ];
  const result = await waitForSiteRevision({
    expectedRevision: expected,
    target: "public",
    timeoutMs: 50,
    intervalMs: 10,
    requestTimeoutMs: 5,
    fetchImpl: async () => responses.shift(),
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    logger: { log: (message) => logs.push(message) },
  });

  assert.deepEqual(result, {
    target: "public",
    url: "https://t4code.com/revision.json",
    revision: expected,
    attempts: 3,
    elapsedMs: 20,
  });
  assert.equal(logs.length, 3);
});

test("waiter has a deterministic deadline and reports the last observed revision", async () => {
  let clock = 0;
  await assert.rejects(
    waitForSiteRevision({
      expectedRevision: expected,
      target: "origin",
      timeoutMs: 20,
      intervalMs: 10,
      requestTimeoutMs: 5,
      fetchImpl: async () => revisionResponse(stale),
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      logger: { log() {} },
    }),
    new RegExp(`Timed out after 20 ms.*revision ${stale}`, "u"),
  );
});

test("verifier rejects mutable SHAs and malformed revision documents", async () => {
  await assert.rejects(
    waitForSiteRevision({ expectedRevision: "main", timeoutMs: 1, intervalMs: 1 }),
    /40-character commit SHA/u,
  );
  await assert.rejects(
    fetchSiteRevision({
      target: "public",
      fetchImpl: async () =>
        new Response(JSON.stringify({ revision: expected, extra: true }), {
          headers: { "content-type": "application/json" },
        }),
    }),
    /invalid revision document/u,
  );
  await assert.rejects(
    fetchSiteRevision({
      target: "public",
      fetchImpl: async () => revisionResponse(expected, { contentType: "text/plain" }),
    }),
    /application\/json/u,
  );
});
