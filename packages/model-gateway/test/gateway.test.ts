import { describe, expect, it } from "vite-plus/test";
import { createGatewayHandler, type GatewayLogEvent } from "../src/gateway.ts";

function fixture(fetch: typeof globalThis.fetch, logs: GatewayLogEvent[] = []) {
	return createGatewayHandler({
		upstreamOrigin: new URL("https://api.example.test"),
		credentialHeader: "authorization",
		credentialValue: "Bearer real-provider-secret",
		allowedPaths: ["/v1/responses", "/v1/models"],
		timeoutMs: 30_000,
		maxRequestBodyBytes: 1_024,
		fetch,
		log: event => logs.push(event),
		now: () => 10,
	});
}

describe("credential-isolating model gateway", () => {
	it("pins the upstream origin, strips caller authority, and injects the configured credential", async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen = { url: String(input), init };
			return new Response("data: done\n\n", { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "unsafe=1" } });
		}) as typeof globalThis.fetch;
		const response = await fixture(fetch)(new Request("http://gateway/v1/responses?mode=stream", {
			method: "POST",
			headers: {
				authorization: "Bearer attacker-value",
				"x-api-key": "attacker-value",
				cookie: "session=unsafe",
				forwarded: "host=attacker.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "test" }),
		}));
		expect(seen?.url).toBe("https://api.example.test/v1/responses?mode=stream");
		const headers = new Headers(seen?.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer real-provider-secret");
		expect(headers.has("x-api-key")).toBe(false);
		expect(headers.has("cookie")).toBe(false);
		expect(headers.has("forwarded")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(await response.text()).toBe("data: done\n\n");
	});

	it("never follows upstream redirects", async () => {
		let redirect: RequestRedirect | undefined;
		const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			redirect = init?.redirect;
			return new Response(null, { status: 307, headers: { location: "https://collector.example/steal" } });
		}) as typeof globalThis.fetch;
		const response = await fixture(fetch)(new Request("http://gateway/v1/responses", { method: "POST", body: "{}" }));
		expect(redirect).toBe("manual");
		expect(response.status).toBe(502);
		expect(response.headers.has("location")).toBe(false);
	});

	it("reloads the credential source for every request", async () => {
		const seen: string[] = [];
		const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization") ?? "");
			return new Response("ok");
		}) as typeof globalThis.fetch;
		let credential = "Bearer first";
		const handler = createGatewayHandler({
			upstreamOrigin: new URL("https://api.example.test"),
			credentialHeader: "authorization",
			credential: async () => credential,
			allowedPaths: ["/v1/models"],
			timeoutMs: 30_000,
			maxRequestBodyBytes: 1_024,
			fetch,
		});
		await handler(new Request("http://gateway/v1/models"));
		credential = "Bearer second";
		await handler(new Request("http://gateway/v1/models"));
		expect(seen).toEqual(["Bearer first", "Bearer second"]);
	});

	it("rejects non-inference provider paths before attaching a credential", async () => {
		let calls = 0;
		const fetch = (async () => { calls += 1; return new Response(); }) as unknown as typeof globalThis.fetch;
		const response = await fixture(fetch)(new Request("http://gateway/v1/fine_tuning/jobs", { method: "POST", body: "{}" }));
		expect(response.status).toBe(404);
		expect(calls).toBe(0);
	});

	it("rejects unsupported methods and declared oversized bodies without contacting upstream", async () => {
		let calls = 0;
		const fetch = (async () => { calls += 1; return new Response(); }) as unknown as typeof globalThis.fetch;
		const handler = fixture(fetch);
		expect((await handler(new Request("http://gateway/v1/models", { method: "DELETE" }))).status).toBe(405);
		expect((await handler(new Request("http://gateway/v1/responses", {
			method: "POST",
			headers: { "content-length": "1025" },
			body: "{}",
		}))).status).toBe(413);
		expect(calls).toBe(0);
	});

	it("returns bounded failures and logs no URL, query, or credential fields", async () => {
		const logs: GatewayLogEvent[] = [];
		const fetch = (async () => { throw new Error("provider failure with secret"); }) as unknown as typeof globalThis.fetch;
		const response = await fixture(fetch, logs)(new Request("http://gateway/v1/responses?prompt=private", { method: "POST", body: "{}" }));
		expect(response.status).toBe(502);
		expect(await response.text()).toBe("upstream request failed\n");
		expect(logs).toEqual([{ result: "upstream_error", method: "POST", status: 502, durationMs: 0 }]);
		expect(JSON.stringify(logs)).not.toContain("private");
		expect(JSON.stringify(logs)).not.toContain("secret");
	});
});
