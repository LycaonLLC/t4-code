import { createGatewayHandler } from "./gateway.ts";
import { readCredential, type ModelGatewayConfig } from "./config.ts";

export interface ModelGatewayServers {
	readonly gateway: ReturnType<typeof Bun.serve>;
	readonly admin: ReturnType<typeof Bun.serve>;
	stop(): Promise<void>;
}

export function startServers(config: ModelGatewayConfig): ModelGatewayServers {
	let draining = false;
	const handler = createGatewayHandler({
		upstreamOrigin: config.upstreamOrigin,
		credentialHeader: config.credentialHeader,
		credential: () => readCredential(config.credentialFile),
		allowedPaths: config.allowedPaths,
		timeoutMs: config.timeoutMs,
		maxRequestBodyBytes: config.maxRequestBodyBytes,
		log: event => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), component: "model-gateway", ...event })}\n`),
	});
	const gateway = Bun.serve({
		hostname: "0.0.0.0",
		port: config.port,
		maxRequestBodySize: config.maxRequestBodyBytes,
		fetch: request => draining ? new Response("draining\n", { status: 503 }) : handler(request),
	});
	const admin = Bun.serve({
		hostname: "0.0.0.0",
		port: config.adminPort,
		fetch: async request => {
			const path = new URL(request.url).pathname;
			if (request.method !== "GET") return new Response("method not allowed\n", { status: 405 });
			if (path === "/healthz") return new Response("ok\n");
			if (path === "/readyz") {
				if (draining) return new Response("draining\n", { status: 503 });
				try {
					await readCredential(config.credentialFile);
					return new Response("ready\n");
				} catch {
					return new Response("credential unavailable\n", { status: 503 });
				}
			}
			return new Response("not found\n", { status: 404 });
		},
	});
	return {
		gateway,
		admin,
		async stop() {
			draining = true;
			await gateway.stop(false);
			await admin.stop(false);
		},
	};
}
