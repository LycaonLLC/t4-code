import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServers, type ModelGatewayServers } from "../src/server.ts";

const roots: string[] = [];
const servers: ModelGatewayServers[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("model gateway servers", () => {
	it("reports readiness from the live credential projection and rejects non-model methods", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "t4-model-gateway-server-"));
		roots.push(root);
		const credentialFile = path.join(root, "credential");
		await writeFile(credentialFile, "Bearer first", { mode: 0o400 });
		const server = startServers({
			upstreamOrigin: new URL("https://api.example.test"),
			credentialHeader: "authorization",
			credentialFile,
			allowedPaths: ["/v1/models"],
			port: 0,
			adminPort: 0,
			timeoutMs: 30_000,
			maxRequestBodyBytes: 1_024,
		});
		servers.push(server);
		const admin = `http://127.0.0.1:${server.admin.port}`;
		const gateway = `http://127.0.0.1:${server.gateway.port}`;
		expect((await fetch(`${admin}/healthz`)).status).toBe(200);
		expect((await fetch(`${admin}/readyz`)).status).toBe(200);
		expect((await fetch(`${gateway}/v1/models`, { method: "DELETE" })).status).toBe(405);

		await unlink(credentialFile);
		expect((await fetch(`${admin}/readyz`)).status).toBe(503);
		await writeFile(credentialFile, "Bearer rotated", { mode: 0o400 });
		expect((await fetch(`${admin}/readyz`)).status).toBe(200);
	});
});
