import { expect } from "vite-plus/test";

const encoder = new TextEncoder();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "T4-API-Version": "1.0", ...headers } });
}

function problem(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, {
    error: {
      code,
      message,
      requestId: `req-${code}`,
      retryable: status >= 500,
      ...extra,
    },
  });
}

function bodyKey(value: unknown): string {
  return JSON.stringify(value);
}

export class T4ApiV1ConformanceService {
  readonly origin = "https://t4-api.conformance.test";
  readonly calls: Array<{ method: string; path: string; authorization: string | null }> = [];
  readonly abortedWatches: string[] = [];

  #workspaceSequence = 0;
  #sessionSequence = 0;
  readonly #workspaces = new Map<string, Record<string, unknown>>();
  readonly #sessions = new Map<string, Record<string, unknown>>();
  readonly #replays = new Map<string, { body: string; response: Record<string, unknown> }>();

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    this.calls.push({ method: request.method, path: url.pathname, authorization });
    if (url.origin !== this.origin) return problem(400, "invalid_origin", "HTTPS API origin is fixed for this client");
    if (url.protocol !== "https:") return problem(400, "https_required", "HTTPS is required");
    if (authorization !== "Bearer token-a" && authorization !== "Bearer token-b") {
      return problem(401, "unauthenticated", "A valid bearer credential is required");
    }
    if (request.headers.get("T4-API-Version") !== "1") {
      return problem(406, "incompatible_version", "No compatible T4 API major version", {
        supportedMajors: [1],
      });
    }
    const tenant = authorization === "Bearer token-a" ? "tenant-a" : "tenant-b";

    if (request.method === "GET" && url.pathname === "/v1") {
      return json(200, {
        apiVersion: "1.0",
        supportedMajors: [1],
        capabilities: [
          "workspace.lifecycle",
          "session.lifecycle",
          "session.commands",
          "session.watch.sse",
        ],
        limits: {
          pageSizeDefault: 2,
          pageSizeMax: 3,
          commandBytesMax: 32,
          watchEventsMax: 4,
          heartbeatSeconds: 15,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/workspaces") {
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 24) {
        return problem(422, "invalid_request", "Request validation failed", {
          violations: [{ field: "name", rule: "length", message: "name must contain 1 to 24 characters" }],
        });
      }
      return this.#idempotent(request, tenant, body, () => {
        const id = `ws-${++this.#workspaceSequence}`;
        const workspace = { id, name: body.name, state: "accepted", revision: 1, tenant };
        this.#workspaces.set(id, workspace);
        return workspace;
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      const pageSize = Number(url.searchParams.get("pageSize") ?? "2");
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 3) {
        return problem(422, "invalid_request", "Request validation failed", {
          violations: [{ field: "pageSize", rule: "range", message: "pageSize must be between 1 and 3" }],
        });
      }
      const start = Number(url.searchParams.get("cursor")?.replace("page-", "") ?? "0");
      const visible = [...this.#workspaces.values()].filter((item) => item.tenant === tenant);
      const items = visible.slice(start, start + pageSize).map(({ tenant: _tenant, ...item }) => item);
      const next = start + items.length < visible.length ? `page-${start + items.length}` : undefined;
      return json(200, { items, ...(next === undefined ? {} : { nextCursor: next }) });
    }

    const workspaceMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)$/u);
    if (workspaceMatch) {
      const id = decodeURIComponent(workspaceMatch[1]!);
      const workspace = this.#workspaces.get(id);
      if (workspace?.tenant !== tenant) return problem(404, "not_found", "Workspace not found");
      if (request.method === "GET") {
        const { tenant: _tenant, ...visible } = workspace;
        return json(200, visible);
      }
      if (request.method === "PATCH") {
        const body = await request.json() as Record<string, unknown>;
        if (request.headers.get("If-Match") !== String(workspace.revision)) {
          return problem(409, "revision_conflict", "Workspace revision changed");
        }
        const updated = { ...workspace, name: body.name ?? workspace.name, revision: Number(workspace.revision) + 1 };
        this.#workspaces.set(id, updated);
        const { tenant: _tenant, ...visible } = updated;
        return json(200, visible);
      }
      if (request.method === "DELETE") {
        this.#workspaces.delete(id);
        return new Response(null, { status: 204, headers: { "T4-API-Version": "1.0" } });
      }
    }

    const sessionsPath = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/sessions$/u);
    if (sessionsPath) {
      const workspaceId = decodeURIComponent(sessionsPath[1]!);
      const workspace = this.#workspaces.get(workspaceId);
      if (workspace?.tenant !== tenant) return problem(404, "not_found", "Workspace not found");
      if (request.method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        return this.#idempotent(request, tenant, body, () => {
          const id = `ses-${++this.#sessionSequence}`;
          const session = { id, workspaceId, title: body.title, state: "accepted", revision: 1, tenant };
          this.#sessions.set(id, session);
          return session;
        });
      }
      if (request.method === "GET") {
        const items = [...this.#sessions.values()]
          .filter((item) => item.workspaceId === workspaceId && item.tenant === tenant)
          .map(({ tenant: _tenant, ...item }) => item);
        return json(200, { items });
      }
    }

    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!);
      const session = this.#sessions.get(id);
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      if (request.method === "GET") {
        const { tenant: _tenant, ...visible } = session;
        return json(200, visible);
      }
      if (request.method === "PATCH") {
        const body = await request.json() as Record<string, unknown>;
        const updated = { ...session, title: body.title ?? session.title, revision: Number(session.revision) + 1 };
        this.#sessions.set(id, updated);
        const { tenant: _tenant, ...visible } = updated;
        return json(200, visible);
      }
      if (request.method === "DELETE") {
        this.#sessions.delete(id);
        return new Response(null, { status: 204, headers: { "T4-API-Version": "1.0" } });
      }
    }

    const cancelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/u);
    if (cancelMatch && request.method === "POST") {
      const session = this.#sessions.get(decodeURIComponent(cancelMatch[1]!));
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      const cancelled = { ...session, state: "cancelled", revision: Number(session.revision) + 1 };
      this.#sessions.set(String(session.id), cancelled);
      const { tenant: _tenant, ...visible } = cancelled;
      return json(202, visible);
    }

    const commandMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/commands$/u);
    if (commandMatch && request.method === "POST") {
      const session = this.#sessions.get(decodeURIComponent(commandMatch[1]!));
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.command !== "string" || encoder.encode(body.command).byteLength > 32) {
        return problem(422, "invalid_request", "Request validation failed", {
          violations: [{ field: "command", rule: "maxBytes", message: "command must not exceed 32 UTF-8 bytes" }],
        });
      }
      const state = ["accepted", "rejected", "conflict", "unavailable", "indeterminate"].includes(body.command)
        ? body.command
        : "accepted";
      return this.#idempotent(request, tenant, body, () => ({ commandId: `cmd-${body.command}`, state }));
    }

    const snapshotMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/snapshot$/u);
    if (snapshotMatch && request.method === "GET") {
      const session = this.#sessions.get(decodeURIComponent(snapshotMatch[1]!));
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      return json(200, { sessionId: session.id, cursor: "cursor-2", state: session.state, entries: [{ sequence: 2, kind: "output", text: "ready" }] });
    }

    const watchMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/u);
    if (watchMatch && request.method === "GET") {
      const id = decodeURIComponent(watchMatch[1]!);
      const session = this.#sessions.get(id);
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      const cursor = url.searchParams.get("cursor") ?? request.headers.get("Last-Event-ID");
      if (cursor === "expired") {
        return problem(410, "cursor_expired", "Watch cursor is no longer retained", {
          resync: { snapshotUrl: `/v1/sessions/${id}/snapshot`, cursor: "cursor-2" },
        });
      }
      const frames = [
        `id: cursor-3\nevent: heartbeat\ndata: {"type":"heartbeat","cursor":"cursor-3","observedAt":"2026-07-21T00:00:00Z"}\n\n`,
        `id: cursor-4\nevent: session\ndata: {"type":"session","cursor":"cursor-4","state":"accepted","revision":2}\n\n`,
      ];
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          request.signal.addEventListener("abort", () => {
            this.abortedWatches.push(id);
            try { controller.close(); } catch { /* already closed */ }
          }, { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "T4-API-Version": "1.0" },
      });
    }

    return problem(404, "not_found", "Resource not found");
  };

  expectNoCredentialLeak(): void {
    expect(this.calls.every((call) => call.authorization === "Bearer token-a" || call.authorization === "Bearer token-b")).toBe(true);
  }

  #idempotent(
    request: Request,
    tenant: string,
    body: Record<string, unknown>,
    create: () => Record<string, unknown>,
  ): Response {
    const key = request.headers.get("Idempotency-Key");
    if (!key) return problem(400, "idempotency_key_required", "Idempotency-Key is required");
    const replayKey = `${tenant}:${request.method}:${new URL(request.url).pathname}:${key}`;
    const prior = this.#replays.get(replayKey);
    if (prior) {
      if (prior.body !== bodyKey(body)) return problem(409, "idempotency_conflict", "Idempotency key was reused with a different request");
      return json(200, prior.response, { "Idempotency-Replayed": "true" });
    }
    const response = create();
    const { tenant: _tenant, ...visible } = response;
    this.#replays.set(replayKey, { body: bodyKey(body), response: visible });
    return json(202, visible, { "Idempotency-Replayed": "false" });
  }
}
