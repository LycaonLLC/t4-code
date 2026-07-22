import { describe, expect, it } from "vite-plus/test";
import { gatewayPrincipal } from "../src/server.ts";

function request(headers: Readonly<Record<string, string>>): Request {
	return new Request("https://cluster.example/v1/ws", { headers });
}

function requestWithRawHeaders(headers: Readonly<Record<string, string>>): Request {
	return {
		headers: { get: (name: string): string | null => headers[name] ?? null },
	} as unknown as Request;
}

describe("cluster gateway Tailscale identity", () => {
	const trustedSource = (address: string): boolean => address === "100.64.0.7";

	it("accepts the Tailscale login only across the explicit trusted HTTPS proxy boundary", () => {
		const input = request({
			"x-forwarded-proto": "https",
			"tailscale-user-login": "operator@example.com",
			"tailscale-user-name": "Operator",
		});
		expect(gatewayPrincipal(input, "100.64.0.7", trustedSource, "tailscale")).toBe("operator@example.com");
	});

	it("rejects identity headers from untrusted sources or non-HTTPS forwarding", () => {
		const identityHeaders = { "x-forwarded-proto": "https", "tailscale-user-login": "attacker@example.com" };
		expect(gatewayPrincipal(request(identityHeaders), "198.51.100.4", trustedSource, "tailscale")).toBeUndefined();
		expect(gatewayPrincipal(request({ ...identityHeaders, "x-forwarded-proto": "http" }), "100.64.0.7", trustedSource, "tailscale")).toBeUndefined();
		expect(gatewayPrincipal(request({ "tailscale-user-login": "attacker@example.com" }), "100.64.0.7", trustedSource, "tailscale")).toBeUndefined();
	});

	it("does not treat the display-name header as an authenticated principal", () => {
		const input = request({ "x-forwarded-proto": "https", "tailscale-user-name": "Spoofed User" });
		expect(gatewayPrincipal(input, "100.64.0.7", trustedSource, "tailscale")).toBeUndefined();
	});

	it("rejects malformed or oversized login identities", () => {
		for (const principal of [" padded@example.com", "line\nbreak", "x".repeat(257)]) {
			const input = requestWithRawHeaders({ "x-forwarded-proto": "https", "tailscale-user-login": principal });
			expect(gatewayPrincipal(input, "100.64.0.7", trustedSource, "tailscale")).toBeUndefined();
		}
	});

	it("fails closed if untyped JavaScript supplies another provider", () => {
		const input = request({ "x-forwarded-proto": "https", "tailscale-user-login": "attacker@example.com" });
		expect(gatewayPrincipal(input, "100.64.0.7", trustedSource, "generic" as "tailscale")).toBeUndefined();
	});
});
