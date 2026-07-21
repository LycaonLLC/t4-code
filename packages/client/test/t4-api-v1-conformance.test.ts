import { describe, expect, it } from "vite-plus/test";

import {
  T4ApiError,
  createT4ApiClient,
  type components,
  type operations,
} from "@t4-code/t4-api-client";
import { T4ApiV1ConformanceService, canonicalJson } from "./t4-api-v1-conformance-service.ts";

type WorkspaceCreate = components["schemas"]["WorkspaceCreate"];
type SessionCreate = components["schemas"]["SessionCreate"];
type CommandCreate = components["schemas"]["CommandCreate"];

type WatchEvent = components["schemas"]["WatchEvent"];
type JsonBody<Response> = Response extends { content: { "application/json": infer Body } } ? Body : never;
type SpawnBadRequest = JsonBody<operations["spawnSession"]["responses"][400]>;
type CommandBadRequest = JsonBody<operations["submitCommand"]["responses"][400]>;
type Unauthorized = JsonBody<operations["discoverV1"]["responses"][401]>;
type Forbidden = JsonBody<operations["discoverV1"]["responses"][403]>;
type Missing = JsonBody<operations["getWorkspace"]["responses"][404]>;
type Conflict = JsonBody<operations["createWorkspace"]["responses"][409]>;
type Unavailable = JsonBody<operations["discoverV1"]["responses"][503]>;

const typedErrors = {
  badSpawn: { error: { code: "idempotency_key_required", message: "required", requestId: "r", retryable: false } } satisfies SpawnBadRequest,
  badCommand: { error: { code: "invalid_request", message: "invalid", requestId: "r", retryable: false } } satisfies CommandBadRequest,
  unauthorized: { error: { code: "unauthenticated", message: "no", requestId: "r", retryable: false } } satisfies Unauthorized,
  forbidden: { error: { code: "forbidden", message: "no", requestId: "r", retryable: false } } satisfies Forbidden,
  missing: { error: { code: "not_found", message: "no", requestId: "r", retryable: false } } satisfies Missing,
  conflict: { error: { code: "idempotency_conflict", message: "no", requestId: "r", retryable: false } } satisfies Conflict,
  unavailable: { error: { code: "unavailable", message: "later", requestId: "r", retryable: true } } satisfies Unavailable,
};

function exhaustWatchEvent(event: WatchEvent): string {
  switch (event.type) {
    case "heartbeat": return event.observedAt;
    case "session": return `${event.state}:${event.revision}`;
    case "command": return `${event.commandId}:${event.state}`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

const VERSION_HEADERS = { "T4-API-Version": "1" } as const;

function idempotencyHeaders(key: string): Readonly<{ "T4-API-Version": "1"; "Idempotency-Key": string }> {
  return { ...VERSION_HEADERS, "Idempotency-Key": key };
}

function mutationHeaders(revision: number, key: string): Readonly<{ "T4-API-Version": "1"; "If-Match": string; "Idempotency-Key": string }> {
  return { ...VERSION_HEADERS, "If-Match": String(revision), "Idempotency-Key": key };
}

function requireData<T>(result: { data?: T; error?: unknown }): T {
  expect(result.error).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data!;
}

describe("generated T4 API v1 client conformance", () => {
  it("negotiates discovery, capabilities, bounds, and rejects an incompatible major", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const discovery = requireData(await client.http.GET("/v1", { params: { header: VERSION_HEADERS } }));
    expect(discovery).toMatchObject({
      apiVersion: "1.0",
      supportedMajors: [1],
      capabilities: expect.arrayContaining(["workspace.lifecycle", "session.watch.sse"]),
      limits: { pageSizeMax: 3, commandBytesMax: 32, watchEventsMax: 4, heartbeatSeconds: 15 },
    });

    const incompatible = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 2, fetch: service.fetch });
    const rejected = await incompatible.http.GET("/v1", { params: { header: VERSION_HEADERS } });
    expect(rejected.response.status).toBe(406);
    expect(rejected.error).toMatchObject({ error: { code: "incompatible_version", retryable: false, supportedMajors: [1] } });
    expect(typedErrors.unauthorized.error.code).toBe("unauthenticated");

    const denied = createT4ApiClient({ baseUrl: service.origin, credential: "token-denied", majorVersion: 1, fetch: service.fetch });
    const forbidden = await denied.http.GET("/v1", { params: { header: VERSION_HEADERS } });
    expect(forbidden.response.status).toBe(403);
    expect(forbidden.error).toEqual(typedErrors.forbidden);
    expect(discovery.limits).toMatchObject({ commandBytesMax: 32, commandRequestBytesMax: 256, commandMetadataValueBytesMax: 32 });
  });

  it("creates, canonically replays, conflicts, mutates, paginates, isolates, and deletes workspaces", async () => {
    const service = new T4ApiV1ConformanceService();
    const owner = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const other = createT4ApiClient({ baseUrl: service.origin, credential: "token-b", majorVersion: 1, fetch: service.fetch });
    const body = { name: "primary", labels: { beta: "2", alpha: "1" } } satisfies WorkspaceCreate;
    const first = await owner.http.POST("/v1/workspaces", {
      body,
      params: { header: idempotencyHeaders("workspace-create-0001") },
    });
    expect(first.response.status).toBe(202);
    const workspace = requireData(first);
    expect(workspace).toMatchObject({ id: "ws-1", state: "accepted", revision: 1 });
    expect(workspace).not.toHaveProperty("tenant");

    const replay = await owner.http.POST("/v1/workspaces", {
      body: { labels: { alpha: "1", beta: "2" }, name: "primary" },
      params: { header: idempotencyHeaders("workspace-create-0001") },
    });
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.data).toEqual(workspace);
    const conflict = await owner.http.POST("/v1/workspaces", {
      body: { name: "different" },
      params: { header: idempotencyHeaders("workspace-create-0001") },
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.error).toMatchObject({ error: { code: "idempotency_conflict", retryable: false } });

    const omitted = await owner.http.POST("/v1/workspaces", {
      body: { name: "primary" }, params: { header: idempotencyHeaders("workspace-omitted-0001") },
    });
    expect(omitted.response.status).toBe(202);
    const explicitEmpty = await owner.http.POST("/v1/workspaces", {
      body: { name: "primary", labels: {} }, params: { header: idempotencyHeaders("workspace-omitted-0001") },
    });
    expect(explicitEmpty.response.status).toBe(409);
    expect(canonicalJson({ z: [1, 2], a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":[1,2]}');
    expect(canonicalJson({ z: [1, 2] })).not.toBe(canonicalJson({ z: [2, 1] }));

    for (const name of ["second", "third", "fourth"]) {
      requireData(await owner.http.POST("/v1/workspaces", {
        body: { name },
        params: { header: idempotencyHeaders(`workspace-${name}-0001`) },
      }));
    }
    const pageOne = requireData(await owner.http.GET("/v1/workspaces", {
      params: { header: VERSION_HEADERS, query: { pageSize: 2 } },
    }));
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.nextCursor).toBe("page-2");
    const pageTwo = requireData(await owner.http.GET("/v1/workspaces", {
      params: { header: VERSION_HEADERS, query: { pageSize: 2, cursor: pageOne.nextCursor! } },
    }));
    expect(pageTwo.items).toHaveLength(2);
    expect(pageTwo.nextCursor).toBeUndefined();

    const isolated = await other.http.GET("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" } },
    });
    expect(isolated.response.status).toBe(404);
    expect(isolated.error).toMatchObject({ error: { code: "not_found" } });
    const invalid = await owner.http.POST("/v1/workspaces", {
      body: { name: "x".repeat(129) },
      params: { header: idempotencyHeaders("workspace-invalid-0001") },
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.error).toMatchObject({ error: { code: "invalid_request", violations: [{ field: "name", rule: "length" }] } });

    const updated = requireData(await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-patch-0001"), path: { workspaceId: "ws-1" } },
      body: { name: "renamed" },
    }));
    expect(updated).toMatchObject({ name: "renamed", revision: 2 });
    const stale = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-patch-0002"), path: { workspaceId: "ws-1" } },
      body: { name: "stale" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });
    const targetOne = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(2, "workspace-shared-0001"), path: { workspaceId: "ws-1" } }, body: { name: "target" },
    });
    const targetTwo = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-shared-0001"), path: { workspaceId: "ws-2" } }, body: { name: "target" },
    });
    expect(targetOne.response.status).toBe(200);
    expect(targetTwo.response.status).toBe(200);
    const changedPrecondition = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(3, "workspace-shared-0001"), path: { workspaceId: "ws-1" } }, body: { name: "target" },
    });
    expect(changedPrecondition.response.status).toBe(409);
    expect(changedPrecondition.error).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect((await owner.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: idempotencyHeaders("workspace-delete-0001"), path: { workspaceId: "ws-1" } },
    })).response.status).toBe(204);
    service.expectNoCredentialLeak();
  });

  it("spawns, paginates, and mutates sessions, then submits idempotent stable command states", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    requireData(await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("workspace-setup-0001") },
    }));
    const body = { title: "agent" } satisfies SessionCreate;
    const first = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: idempotencyHeaders("session-spawn-0001"), path: { workspaceId: "ws-1" } },
      body,
    });
    expect(first.response.status).toBe(202);
    const session = requireData(first);
    const replay = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: idempotencyHeaders("session-spawn-0001"), path: { workspaceId: "ws-1" } },
      body,
    });
    expect(replay.data).toEqual(session);
    for (const [key, title] of [["session-spawn-0002", "agent-two"], ["session-spawn-0003", "agent-three"]] as const) {
      requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        params: { header: idempotencyHeaders(key), path: { workspaceId: "ws-1" } }, body: { title },
      }));
    }
    const sessionPageOne = requireData(await client.http.GET("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" }, query: { pageSize: 2 } },
    }));
    expect(sessionPageOne.items).toHaveLength(2);
    expect(sessionPageOne.nextCursor).toBe("page-2");
    const sessionPageTwo = requireData(await client.http.GET("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" }, query: { pageSize: 2, cursor: sessionPageOne.nextCursor! } },
    }));
    expect(sessionPageTwo.items).toHaveLength(1);

    const mutated = requireData(await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: mutationHeaders(1, "session-patch-0001"), path: { sessionId: "ses-1" } }, body: { title: "renamed-agent" },
    }));
    expect(mutated).toMatchObject({ title: "renamed-agent", revision: 2 });
    const stale = await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: mutationHeaders(1, "session-patch-0002"), path: { sessionId: "ses-1" } }, body: { title: "stale-agent" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });

    for (const state of ["accepted", "rejected", "conflict", "unavailable", "indeterminate"] as const) {
      const command = { command: state, metadata: {} } satisfies CommandCreate;
      const result = await client.http.POST("/v1/sessions/{sessionId}/commands", {
        params: { header: idempotencyHeaders(`command-${state}-0001`), path: { sessionId: "ses-1" } }, body: command,
      });
      expect(requireData(result).state).toBe(state);
      const commandReplay = await client.http.POST("/v1/sessions/{sessionId}/commands", {
        params: { header: idempotencyHeaders(`command-${state}-0001`), path: { sessionId: "ses-1" } }, body: command,
      });
      expect(commandReplay.data).toEqual(result.data);
      expect(commandReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    }
    const oversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-oversized-0001"), path: { sessionId: "ses-1" } },
      body: { command: "a".repeat(33), metadata: {} },
    });
    expect(oversized.response.status).toBe(422);
    expect(oversized.error).toMatchObject({ error: { violations: [{ field: "command", rule: "maxBytes" }] } });
    const multibyteOversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-multibyte-0001"), path: { sessionId: "ses-1" } },
      body: { command: "é".repeat(17), metadata: {} },
    });
    expect(multibyteOversized.response.status).toBe(422);
    const metadataOversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-metadata-0001"), path: { sessionId: "ses-1" } },
      body: { command: "ok", metadata: { source: "é".repeat(17) } },
    });
    expect(metadataOversized.response.status).toBe(422);
    const requestOversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-request-0001"), path: { sessionId: "ses-1" } },
      body: { command: "ok", metadata: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field-${index}`, "x".repeat(32)])) },
    });
    expect(requestOversized.response.status).toBe(422);
    const defaultedMetadataResponse = await service.fetch(`${service.origin}/v1/sessions/ses-1/commands`, {
      method: "POST",
      headers: { Authorization: "Bearer token-a", "T4-API-Version": "1", "Idempotency-Key": "command-default-0001", "Content-Type": "application/json" },
      body: '{"command":"ok"}',
    });
    const explicitMetadata = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-default-0001"), path: { sessionId: "ses-1" } }, body: { command: "ok", metadata: {} },
    });
    expect(explicitMetadata.data).toEqual(await defaultedMetadataResponse.json());
    const cancelled = await client.http.POST("/v1/sessions/{sessionId}/cancel", {
      params: { header: idempotencyHeaders("session-cancel-0001"), path: { sessionId: "ses-1" } },
    });
    expect(cancelled.response.status).toBe(202);
    expect(cancelled.data).toMatchObject({ state: "cancelled" });
  });

  it("takes a snapshot and watches bounded SSE with heartbeat, reconnect, cancellation, and typed resync", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    requireData(await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("workspace-watch-0001") },
    }));
    requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: idempotencyHeaders("session-watch-0001"), path: { workspaceId: "ws-1" } }, body: { title: "agent" },
    }));
    const snapshot = requireData(await client.http.GET("/v1/sessions/{sessionId}/snapshot", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
    }));
    expect(snapshot).toMatchObject({ sessionId: "ses-1", cursor: "cursor-2", entries: [{ sequence: 2 }] });

    const received: Array<components["schemas"]["WatchEvent"]> = [];
    for await (const event of client.watchSession("ses-1", { cursor: snapshot.cursor, maxEvents: 3, maxReconnectAttempts: 2, retryBackoffMs: 0 })) {
      received.push(event);
    }
    expect(received).toEqual([
      expect.objectContaining({ type: "heartbeat", cursor: "cursor-3" }),
      expect.objectContaining({ type: "session", cursor: "cursor-4", state: "accepted" }),
      expect.objectContaining({ type: "heartbeat", cursor: "cursor-5" }),
    ]);
    expect(received.map(exhaustWatchEvent)).toEqual(["2026-07-21T00:00:00Z", "accepted:2", "2026-07-21T00:00:15Z"]);
    expect(service.watchCursors[0]).toEqual({ query: "cursor-2", header: "cursor-2" });
    expect(service.watchCursors[1]).toEqual({ query: "cursor-4", header: "cursor-4" });

    await expect(async () => {
      for await (const _event of client.watchSession("ses-1", { cursor: "expired", maxEvents: 1 })) {
        throw new Error("expired cursor unexpectedly produced an event");
      }
    }).rejects.toMatchObject({
      name: "T4ApiError",
      code: "cursor_expired",
      status: 410,
      resync: { snapshotUrl: "/v1/sessions/ses-1/snapshot", cursor: "cursor-2" },
    } satisfies Partial<T4ApiError>);
  });

  it("rejects malformed mutation idempotency and watch query contracts", async () => {
    const service = new T4ApiV1ConformanceService();
    const baseHeaders = { Authorization: "Bearer token-a", "T4-API-Version": "1", "Content-Type": "application/json" };
    const created = await service.fetch(`${service.origin}/v1/workspaces`, { method: "POST", headers: { ...baseHeaders, "Idempotency-Key": "workspace-raw-0001" }, body: '{"name":"workspace"}' });
    expect(created.status).toBe(202);
    const missingSpawn = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, { method: "POST", headers: baseHeaders, body: '{"title":"agent"}' });
    expect(missingSpawn.status).toBe(400);
    expect(await missingSpawn.json()).toMatchObject(typedErrors.badSpawn);
    const invalidSpawn = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, { method: "POST", headers: { ...baseHeaders, "Idempotency-Key": "short" }, body: '{"title":"agent"}' });
    expect(invalidSpawn.status).toBe(400);
    const spawned = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, { method: "POST", headers: { ...baseHeaders, "Idempotency-Key": "session-raw-00001" }, body: '{"title":"agent"}' });
    expect(spawned.status).toBe(202);
    for (const [method, path, body] of [
      ["PATCH", "/v1/workspaces/ws-1", '{"name":"x"}'],
      ["DELETE", "/v1/workspaces/ws-1", undefined],
      ["PATCH", "/v1/sessions/ses-1", '{"title":"x"}'],
      ["DELETE", "/v1/sessions/ses-1", undefined],
      ["POST", "/v1/sessions/ses-1/cancel", undefined],
      ["POST", "/v1/sessions/ses-1/commands", '{"command":"ok"}'],
    ] as const) {
      const response = await service.fetch(`${service.origin}${path}`, { method, headers: { ...baseHeaders, "If-Match": "1" }, ...(body === undefined ? {} : { body }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
    }
    for (const query of ["maxEvents=0", "maxEvents=5", "heartbeatSeconds=4", "heartbeatSeconds=61"]) {
      const response = await service.fetch(`${service.origin}/v1/sessions/ses-1/events?${query}`, { headers: baseHeaders });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request", violations: expect.any(Array) } });
    }
  });

  it("parses per-frame byte bounds across arbitrary chunks and split UTF-8", async () => {
    const sse = (chunks: Uint8Array[]): typeof globalThis.fetch => async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const encoder = new TextEncoder();
    const valid = `: 💚\nid: c1\ndata: {"type":"heartbeat","cursor":"c1","observedAt":"2026-07-21T00:00:00Z"}\n\n`;
    const bytes = encoder.encode(valid);
    const split = [...bytes].map((byte) => Uint8Array.of(byte));
    const splitClient = createT4ApiClient({ baseUrl: "https://split.test", credential: "token-a", majorVersion: 1, fetch: sse(split) });
    const iterator = splitClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 });
    expect((await iterator.next()).value).toMatchObject({ type: "heartbeat", cursor: "c1" });

    const small = `data: {"type":"heartbeat","cursor":"c1","observedAt":"2026-07-21T00:00:00Z"}\n${`: ${"x".repeat(1010)}\n`}\n`;
    const manyClient = createT4ApiClient({ baseUrl: "https://many.test", credential: "token-a", majorVersion: 1, fetch: sse([encoder.encode(small.repeat(1000))]) });
    let count = 0;
    for await (const _event of manyClient.watchSession("ses-1", { maxEvents: 1000, maxReconnectAttempts: 0 })) count += 1;
    expect(count).toBe(1000);

    const oversized = encoder.encode(`: ${"x".repeat(1024 * 1024)}\ndata: {"type":"heartbeat","cursor":"c1","observedAt":"2026-07-21T00:00:00Z"}\n\n`);
    const oversizedChunks = Array.from({ length: Math.ceil(oversized.byteLength / 1024) }, (_, index) => oversized.slice(index * 1024, (index + 1) * 1024));
    const oversizedClient = createT4ApiClient({ baseUrl: "https://large.test", credential: "token-a", majorVersion: 1, fetch: sse(oversizedChunks) });
    await expect(oversizedClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });
  });

  it("fails closed on unknown watch fields and incomplete typed errors", async () => {
    const eventFetch: typeof globalThis.fetch = async () => new Response('data: {"type":"heartbeat","cursor":"c1","observedAt":"2026-07-21T00:00:00Z","unknown":true}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    const eventClient = createT4ApiClient({ baseUrl: "https://unknown.test", credential: "token-a", majorVersion: 1, fetch: eventFetch });
    await expect(eventClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });
    for (const [status, code] of [[410, "cursor_expired"], [406, "incompatible_version"], [422, "invalid_request"]] as const) {
      const fetch: typeof globalThis.fetch = async () => Response.json({ error: { code, message: "incomplete", requestId: "r", retryable: false } }, { status });
      const client = createT4ApiClient({ baseUrl: "https://errors.test", credential: "token-a", majorVersion: 1, fetch });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status });
    }
  });

  it("bounds automatic EOF retry and supports explicit abort", async () => {
    let attempts = 0;
    const eofFetch: typeof globalThis.fetch = async () => {
      attempts += 1;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    };
    const eofClient = createT4ApiClient({ baseUrl: "https://eof.test", credential: "token-a", majorVersion: 1, fetch: eofFetch });
    await expect(eofClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 2, retryBackoffMs: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });
    expect(attempts).toBe(3);

    const reconnectHeaders: Array<string | null> = [];
    let networkAttempt = 0;
    const networkFetch: typeof globalThis.fetch = async (_input, init) => {
      reconnectHeaders.push(new Headers(init?.headers).get("Last-Event-ID"));
      networkAttempt += 1;
      if (networkAttempt === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('data: {"type":"heartbeat","cursor":"network-1","observedAt":"2026-07-21T00:00:00Z"}\n\n'));
            stream.error(new TypeError("transient network loss"));
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response('data: {"type":"session","cursor":"network-2","state":"ready","revision":2}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    const networkClient = createT4ApiClient({ baseUrl: "https://network.test", credential: "token-a", majorVersion: 1, fetch: networkFetch });
    const networkEvents: WatchEvent[] = [];
    for await (const event of networkClient.watchSession("ses-1", { maxEvents: 2, maxReconnectAttempts: 1, retryBackoffMs: 0 })) networkEvents.push(event);
    expect(networkEvents.map((event) => event.cursor)).toEqual(["network-1", "network-2"]);
    expect(reconnectHeaders).toEqual([null, "network-1"]);

    const controller = new AbortController();
    const abortFetch: typeof globalThis.fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(stream) { init?.signal?.addEventListener("abort", () => stream.close(), { once: true }); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const abortClient = createT4ApiClient({ baseUrl: "https://abort.test", credential: "token-a", majorVersion: 1, fetch: abortFetch });
    const pending = abortClient.watchSession("ses-1", { signal: controller.signal }).next();
    controller.abort("done");
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});
