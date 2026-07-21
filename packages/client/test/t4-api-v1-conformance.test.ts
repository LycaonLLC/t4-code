import { describe, expect, it } from "vite-plus/test";

import {
  T4ApiError,
  createT4ApiClient,
  type components,
} from "@t4-code/t4-api-client";
import { T4ApiV1ConformanceService } from "./t4-api-v1-conformance-service.ts";

type WorkspaceCreate = components["schemas"]["WorkspaceCreate"];
type SessionCreate = components["schemas"]["SessionCreate"];
type CommandCreate = components["schemas"]["CommandCreate"];

function requireData<T>(result: { data?: T; error?: unknown }): T {
  expect(result.error).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data!;
}

describe("generated T4 API v1 client conformance", () => {
  it("negotiates discovery, capabilities, bounds, and rejects an incompatible major", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const discovery = requireData(await client.http.GET("/v1"));
    expect(discovery).toMatchObject({
      apiVersion: "1.0",
      supportedMajors: [1],
      capabilities: expect.arrayContaining(["workspace.lifecycle", "session.watch.sse"]),
      limits: { pageSizeMax: 3, commandBytesMax: 32, watchEventsMax: 4, heartbeatSeconds: 15 },
    });

    const incompatible = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 2, fetch: service.fetch });
    const rejected = await incompatible.http.GET("/v1");
    expect(rejected.response.status).toBe(406);
    expect(rejected.error).toMatchObject({ error: { code: "incompatible_version", retryable: false, supportedMajors: [1] } });
  });

  it("creates, replays, conflicts, mutates, lists, isolates, and deletes bounded workspaces", async () => {
    const service = new T4ApiV1ConformanceService();
    const owner = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const other = createT4ApiClient({ baseUrl: service.origin, credential: "token-b", majorVersion: 1, fetch: service.fetch });
    const body = { name: "primary" } satisfies WorkspaceCreate;
    const first = await owner.http.POST("/v1/workspaces", { body, headers: { "Idempotency-Key": "workspace-create-1" } });
    expect(first.response.status).toBe(202);
    const workspace = requireData(first);
    expect(workspace).toMatchObject({ id: "ws-1", state: "accepted", revision: 1 });
    expect(workspace).not.toHaveProperty("tenant");

    const replay = await owner.http.POST("/v1/workspaces", { body, headers: { "Idempotency-Key": "workspace-create-1" } });
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.data).toEqual(workspace);
    const conflict = await owner.http.POST("/v1/workspaces", {
      body: { name: "different" },
      headers: { "Idempotency-Key": "workspace-create-1" },
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.error).toMatchObject({ error: { code: "idempotency_conflict", retryable: false } });

    for (const name of ["second", "third", "fourth"]) {
      requireData(await owner.http.POST("/v1/workspaces", { body: { name }, headers: { "Idempotency-Key": `workspace-${name}` } }));
    }
    const pageOne = requireData(await owner.http.GET("/v1/workspaces", { params: { query: { pageSize: 2 } } }));
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.nextCursor).toBe("page-2");
    const pageTwo = requireData(await owner.http.GET("/v1/workspaces", { params: { query: { pageSize: 2, cursor: pageOne.nextCursor } } }));
    expect(pageTwo.items).toHaveLength(2);
    expect(pageTwo.nextCursor).toBeUndefined();

    const isolated = await other.http.GET("/v1/workspaces/ws-1", { params: { path: { workspaceId: "ws-1" } } });
    expect(isolated.response.status).toBe(404);
    expect(isolated.error).toMatchObject({ error: { code: "not_found" } });
    const invalid = await owner.http.POST("/v1/workspaces", { body: { name: "x".repeat(25) }, headers: { "Idempotency-Key": "invalid" } });
    expect(invalid.response.status).toBe(422);
    expect(invalid.error).toMatchObject({ error: { code: "invalid_request", violations: [{ field: "name", rule: "length" }] } });

    const updated = requireData(await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "ws-1" } }, body: { name: "renamed" }, headers: { "If-Match": "1" },
    }));
    expect(updated).toMatchObject({ name: "renamed", revision: 2 });
    const stale = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "ws-1" } }, body: { name: "stale" }, headers: { "If-Match": "1" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });
    expect((await owner.http.DELETE("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: "ws-1" } } })).response.status).toBe(204);
    service.expectNoCredentialLeak();
  });

  it("spawns and mutates sessions, submits idempotent commands, and exposes stable states", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    requireData(await client.http.POST("/v1/workspaces", { body: { name: "workspace" }, headers: { "Idempotency-Key": "workspace" } }));
    const body = { title: "agent" } satisfies SessionCreate;
    const first = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { path: { workspaceId: "ws-1" } }, body, headers: { "Idempotency-Key": "spawn-1" },
    });
    expect(first.response.status).toBe(202);
    const session = requireData(first);
    const replay = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { path: { workspaceId: "ws-1" } }, body, headers: { "Idempotency-Key": "spawn-1" },
    });
    expect(replay.data).toEqual(session);
    const listed = requireData(await client.http.GET("/v1/workspaces/{workspaceId}/sessions", {
      params: { path: { workspaceId: "ws-1" } },
    }));
    expect(listed.items).toEqual([session]);
    const mutated = requireData(await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { path: { sessionId: "ses-1" } }, body: { title: "renamed-agent" }, headers: { "If-Match": "1" },
    }));
    expect(mutated).toMatchObject({ title: "renamed-agent", revision: 2 });

    for (const state of ["accepted", "rejected", "conflict", "unavailable", "indeterminate"] as const) {
      const command = { command: state } satisfies CommandCreate;
      const result = await client.http.POST("/v1/sessions/{sessionId}/commands", {
        params: { path: { sessionId: "ses-1" } }, body: command, headers: { "Idempotency-Key": `command-${state}` },
      });
      expect(requireData(result).state).toBe(state);
      const commandReplay = await client.http.POST("/v1/sessions/{sessionId}/commands", {
        params: { path: { sessionId: "ses-1" } }, body: command, headers: { "Idempotency-Key": `command-${state}` },
      });
      expect(commandReplay.data).toEqual(result.data);
      expect(commandReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    }
    const oversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { path: { sessionId: "ses-1" } }, body: { command: "a".repeat(33) }, headers: { "Idempotency-Key": "oversized" },
    });
    expect(oversized.response.status).toBe(422);
    expect(oversized.error).toMatchObject({ error: { violations: [{ field: "command", rule: "maxBytes" }] } });
    const cancelled = await client.http.POST("/v1/sessions/{sessionId}/cancel", { params: { path: { sessionId: "ses-1" } } });
    expect(cancelled.response.status).toBe(202);
    expect(cancelled.data).toMatchObject({ state: "cancelled" });
  });

  it("takes a snapshot and watches bounded SSE with heartbeat, reconnect cursor, cancellation, and typed resync", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    requireData(await client.http.POST("/v1/workspaces", { body: { name: "workspace" }, headers: { "Idempotency-Key": "workspace" } }));
    requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { path: { workspaceId: "ws-1" } }, body: { title: "agent" }, headers: { "Idempotency-Key": "session" },
    }));
    const snapshot = requireData(await client.http.GET("/v1/sessions/{sessionId}/snapshot", { params: { path: { sessionId: "ses-1" } } }));
    expect(snapshot).toMatchObject({ sessionId: "ses-1", cursor: "cursor-2", entries: [{ sequence: 2 }] });

    const controller = new AbortController();
    const received: Array<components["schemas"]["WatchEvent"]> = [];
    for await (const event of client.watchSession("ses-1", { cursor: snapshot.cursor, maxEvents: 2, signal: controller.signal })) {
      received.push(event);
      if (received.length === 2) controller.abort();
    }
    expect(received).toEqual([
      expect.objectContaining({ type: "heartbeat", cursor: "cursor-3" }),
      expect.objectContaining({ type: "session", cursor: "cursor-4", state: "accepted" }),
    ]);
    expect(service.calls.at(-1)?.path).toBe("/v1/sessions/ses-1/events");
    expect(service.abortedWatches).toEqual(["ses-1"]);

    const reconnect = client.watchSession("ses-1", { cursor: received.at(-1)!.cursor, maxEvents: 1 });
    expect((await reconnect.next()).value).toMatchObject({ type: "heartbeat", cursor: "cursor-3" });
    await reconnect.return(undefined);

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
});
