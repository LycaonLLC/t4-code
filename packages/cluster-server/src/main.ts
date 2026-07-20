#!/usr/bin/env bun
import { clusterServerConfigFromEnv, loadKubernetesCredentials } from "./config.ts";
import { ClusterGateway } from "./gateway.ts";
import { KubernetesApiClient, KubernetesGatewayMutationBackend } from "./kubernetes-client.ts";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import { KubernetesProjectionRunner } from "./kubernetes-runner.ts";
import { ClusterMetrics, ClusterServerHealth, JsonLogger } from "./observability.ts";
import { WebSocketPodHostConnector } from "./pod-host-router.ts";
import { startClusterHttpServers } from "./server.ts";
import { SessionAuthorityRunner } from "./session-authority-runner.ts";
import { WoodpeckerProvider } from "./woodpecker.ts";

export async function runClusterServer(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
	const config = clusterServerConfigFromEnv(env);
	const logger = new JsonLogger(undefined, { component: "cluster-server", version: "0.1.30", namespace: config.namespace });
	const health = new ClusterServerHealth();
	const metrics = new ClusterMetrics({ component: "cluster-server", version: "0.1.30", namespace: config.namespace });
	const credentials = await loadKubernetesCredentials(config);
	const kubernetes = new KubernetesApiClient({
		baseUrl: config.kubernetesBaseUrl,
		namespace: config.namespace,
		token: credentials.token,
		ca: credentials.ca,
	});
	const projection = new ClusterInfrastructureProjection({ epoch: config.epoch, namespace: config.namespace });
	const runner = new KubernetesProjectionRunner({
		client: kubernetes,
		projection,
		hostName: config.hostName,
		onSynchronized: () => health.markKubernetesSynced(),
		onError: error => {
			health.markKubernetesUnavailable();
			logger.warn("Kubernetes watch reconnecting", { condition: error instanceof Error ? error.name : "unknown", result: "failure" });
		},
	});
	await runner.start();
	const connector = new WebSocketPodHostConnector({ internalToken: config.internalToken });
	const authority = new SessionAuthorityRunner({
		projection,
		connector,
		onError: error => logger.warn("session authority reconnecting", { condition: error instanceof Error ? error.name : "unknown", result: "failure" }),
	});
	authority.start();
	const ciProvider = config.woodpecker ? new WoodpeckerProvider(config.woodpecker) : undefined;
	const gateway = new ClusterGateway({
		projection,
		connector,
		mutations: new KubernetesGatewayMutationBackend({ client: kubernetes, hostRef: config.hostName }),
		internalToken: config.internalToken,
		...(ciProvider ? { ciProvider } : {}),
	});
	const servers = startClusterHttpServers({
		gateway,
		projection,
		gatewayPort: config.gatewayPort,
		adminPort: config.adminPort,
		trustedProxyAddresses: config.trustedProxyAddresses,
		trustedProxyCidrs: config.trustedProxyCidrs,
		health,
		metrics,
		logger,
	});
	const stopped = Promise.withResolvers<void>();
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		void (async () => {
			await servers.drain();
			await authority.stop();
			await runner.stop();
			await servers.stop();
		})().then(stopped.resolve, stopped.reject);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try { await stopped.promise; }
	finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		if (!stopping) {
			await servers.stop();
			await authority.stop();
			await runner.stop();
		}
	}
}

async function main(): Promise<void> {
	try { await runClusterServer(); }
	catch (error) {
		const logger = new JsonLogger(undefined, { component: "cluster-server", version: "0.1.30" });
		logger.error("cluster server failed", { condition: error instanceof Error ? error.name : "unknown", result: "failure" });
		process.exitCode = 1;
	}
}
if (import.meta.main) await main();
