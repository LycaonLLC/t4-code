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

const VERSION_HEADERS = { "T4-API-Version": "1" } as const;

function idempotencyHeaders(key: string): Readonly<{ "T4-API-Version": "1"; "Idempotency-Key": string }> {
  return { ...VERSION_HEADERS, "Idempotency-Key": key };
}

function revisionHeaders(revision: number): Readonly<{ "T4-API-Version": "1"; "If-Match": string }> {
  return { ...VERSION_HEADERS, "If-Match": String(revision) };
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
      params: { header: VERSION_HEADERS, query: { pageSize: 2, cursor: pageOne.nextCursor } },
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
      params: { header: revisionHeaders(1), path: { workspaceId: "ws-1" } },
      body: { name: "renamed" },
    }));
    expect(updated).toMatchObject({ name: "renamed", revision: 2 });
    const stale = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: revisionHeaders(1), path: { workspaceId: "ws-1" } },
      body: { name: "stale" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });
    expect((await owner.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" } },
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
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" }, query: { pageSize: 2, cursor: sessionPageOne.nextCursor } },
    }));
    expect(sessionPageTwo.items).toHaveLength(1);

    const mutated = requireData(await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: revisionHeaders(1), path: { sessionId: "ses-1" } }, body: { title: "renamed-agent" },
    }));
    expect(mutated).toMatchObject({ title: "renamed-agent", revision: 2 });
    const stale = await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: revisionHeaders(1), path: { sessionId: "ses-1" } }, body: { title: "stale-agent" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });

    for (const state of ["accepted", "rejected", "conflict", "unavailable", "indeterminate"] as const) {
      const command = { command: state } satisfies CommandCreate;
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
      body: { command: "a".repeat(33) },
    });
    expect(oversized.response.status).toBe(422);
    expect(oversized.error).toMatchObject({ error: { violations: [{ field: "command", rule: "maxBytes" }] } });
    const cancelled = await client.http.POST("/v1/sessions/{sessionId}/cancel", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
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

    const controller = new AbortController();
    const received: Array<components["schemas"]["WatchEvent"]> = [];
    for await (const event of client.watchSession("ses-1", { cursor: snapshot.cursor, maxEvents: 4, signal: controller.signal })) {
      received.push(event);
      if (received.length === 2) controller.abort();
    }
    expect(received).toEqual([
      expect.objectContaining({ type: "heartbeat", cursor: "cursor-3" }),
      expect.objectContaining({ type: "session", cursor: "cursor-4", state: "accepted" }),
    ]);
    expect(service.abortedWatches).toEqual(["ses-1"]);
    expect(service.watchCursors[0]).toEqual({ query: "cursor-2", header: "cursor-2" });

    const reconnect = client.watchSession("ses-1", { cursor: received.at(-1)!.cursor, maxEvents: 2 });
    expect((await reconnect.next()).value).toMatchObject({ type: "heartbeat", cursor: "cursor-5" });
    await reconnect.return(undefined);
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
});
