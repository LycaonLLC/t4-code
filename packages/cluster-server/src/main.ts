#!/usr/bin/env bun
import { CiProjectionRunner } from "./ci-projection-runner.ts";
import { clusterServerConfigFromEnv, loadKubernetesCa, loadPostgresUrl } from "./config.ts";
import { ClusterGateway } from "./gateway.ts";
import { KubernetesApiClient, KubernetesGatewayMutationBackend } from "./kubernetes-client.ts";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import { KubernetesProjectionRunner } from "./kubernetes-runner.ts";
import { ClusterMetrics, ClusterServerHealth, JsonLogger } from "./observability.ts";
import { WebSocketPodHostConnector } from "./pod-host-router.ts";
import { startClusterHttpServers, type ClusterHttpServers } from "./server.ts";
import { SessionAuthorityRunner } from "./session-authority-runner.ts";
import { WoodpeckerProvider } from "./woodpecker.ts";
import { PostgresLedger } from "./ledger.ts";
import { DurableOutboxWorker } from "./outbox-worker.ts";
import { loadPublicApiSecrets } from "./public-api-auth.ts";
import { T4PublicApiV1 } from "./public-api-v1.ts";
import { PublicKubernetesOutboxApplier } from "./public-kubernetes-applier.ts";

export async function runClusterServer(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
	const config = clusterServerConfigFromEnv(env);
	const logger = new JsonLogger(undefined, { component: "cluster-server", version: "0.1.30", namespace: config.namespace });
	const health = new ClusterServerHealth();
	const metrics = new ClusterMetrics({ component: "cluster-server", version: "0.1.30", namespace: config.namespace });
	const ca = await loadKubernetesCa(config);
	const kubernetes = new KubernetesApiClient({
		baseUrl: config.kubernetesBaseUrl,
		namespace: config.namespace,
		tokenFile: config.kubernetesTokenPath,
		ca,
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

	const stopped = Promise.withResolvers<void>();
	const stop = (): void => stopped.resolve();
	let authority: SessionAuthorityRunner | undefined;
	let ciProjection: CiProjectionRunner | undefined;
	let servers: ClusterHttpServers | undefined;
	let ledger: PostgresLedger | undefined;
	let outboxAbort: AbortController | undefined;
	let outboxTask: Promise<void> | undefined;
	let signalsInstalled = false;
	try {
		if (!config.postgres || !config.publicApiCredentialsFile) throw new Error("public API durable storage configuration is required");
		const [databaseUrl, publicApiSecrets] = await Promise.all([
			loadPostgresUrl(config),
			loadPublicApiSecrets(config.publicApiCredentialsFile),
		]);
		ledger = new PostgresLedger({ url: databaseUrl, cursorSecret: publicApiSecrets.cursorSecret });
		await ledger.migrate();
		const publicApi = new T4PublicApiV1({ ledger, authenticator: publicApiSecrets.authenticator });
		const outbox = new DurableOutboxWorker({
			ledger,
			ownerId: config.epoch,
			applier: new PublicKubernetesOutboxApplier({ client: kubernetes, hostRef: config.hostName }),
		});
		outboxAbort = new AbortController();
		outboxTask = (async () => {
			while (!outboxAbort!.signal.aborted) {
				try {
					await outbox.acquireLease();
					await outbox.drain();
				} catch (error) {
					logger.warn("durable outbox recovery retrying", { condition: error instanceof Error ? error.name : "unknown", result: "failure" });
				}
				if (!outboxAbort!.signal.aborted) await Bun.sleep(1_000);
			}
		})();
		await runner.start();
		const connector = new WebSocketPodHostConnector({ identityTokenFile: config.identityTokenPath });
		authority = new SessionAuthorityRunner({
			projection,
			connector,
			onError: error => logger.warn("session authority reconnecting", { condition: error instanceof Error ? error.name : "unknown", result: "failure" }),
		});
		authority.start();
		const ciProvider = config.woodpecker ? new WoodpeckerProvider(config.woodpecker) : undefined;
		if (ciProvider) {
			ciProjection = new CiProjectionRunner({
				projection,
				provider: ciProvider,
				onError: error => logger.warn("CI projection refresh failed", { condition: error instanceof Error ? error.name : "unknown", result: "failure" }),
			});
			ciProjection.start();
		}
		const gateway = new ClusterGateway({
			projection,
			connector,
			mutations: new KubernetesGatewayMutationBackend({ client: kubernetes, hostRef: config.hostName }),
			...(ciProvider ? { ciProvider } : {}),
		});
		servers = startClusterHttpServers({
			gateway,
			publicApi,
			projection,
			gatewayPort: config.gatewayPort,
			adminPort: config.adminPort,
			identityProvider: config.identityProvider,
			trustedProxyAddresses: config.trustedProxyAddresses,
			trustedProxyCidrs: config.trustedProxyCidrs,
			health,
			metrics,
			logger,
		});
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		signalsInstalled = true;
		await stopped.promise;
	} finally {
		if (signalsInstalled) {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
		}
		try {
			await servers?.drain();
		} finally {
			try {
				await ciProjection?.stop();
			} finally {
				try {
					await authority?.stop();
				} finally {
					try {
						await runner.stop();
					} finally {
						try {
							outboxAbort?.abort();
							await outboxTask;
						} finally {
							try { await servers?.stop(); }
							finally { await ledger?.close(); }
						}
					}
				}
			}
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
