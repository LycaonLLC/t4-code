import { KubernetesApiClient, KubernetesApiError } from "./kubernetes-client.ts";
import {
	ClusterInfrastructureProjection,
	KubernetesAuthorityInvalidatedError,
	type InfrastructureList,
	type KubernetesResource,
	type KubernetesWatchEvent,
} from "./kubernetes-projection.ts";
import type {
	AuthoritativeKubernetesStatusIngress,
	AuthoritativeKubernetesStatusObservation,
	KubernetesStatusCollection,
} from "./ledger.ts";

export interface KubernetesProjectionRunnerOptions {
	readonly client: KubernetesApiClient;
	readonly projection: ClusterInfrastructureProjection;
	readonly hostName: string;
	readonly onSynchronized?: () => void;
	readonly onError?: (error: unknown) => void;
	readonly statusIngress?: (
		collection: KubernetesStatusCollection,
		observation: AuthoritativeKubernetesStatusIngress,
	) => Promise<void>;
	readonly retryMs?: number;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const finish = (): void => { signal.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, milliseconds);
		const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
	});
}

/** Rebuildable list/watch runner. Kubernetes remains the sole infrastructure source. */
export class KubernetesProjectionRunner {
	readonly #options: KubernetesProjectionRunnerOptions;
	readonly #synchronized = new Set<string>();
	readonly #workspaceOwners = new Map<string, string>();
	#abort?: AbortController;
	#running?: Promise<void>;
	#relist?: Promise<void>;
	constructor(options: KubernetesProjectionRunnerOptions) { this.#options = options; }

	async start(): Promise<void> {
		if (this.#running) throw new Error("Kubernetes projection runner already started");
		this.#abort = new AbortController();
		const signal = this.#abort.signal;
		const initial = await this.#options.client.listInfrastructure(this.#options.hostName, signal);
		await this.#prepareSnapshot(initial, signal);
		this.#options.projection.replace(initial);
		this.#synchronized.clear();
		for (const resource of ["t4clusterhosts", "t4workspaces", "t4sessions"]) this.#synchronized.add(resource);
		this.#options.onSynchronized?.();
		this.#running = this.#run(signal);
	}

	async stop(): Promise<void> {
		this.#abort?.abort(new Error("Kubernetes projection runner stopped"));
		await this.#running?.catch(() => undefined);
		this.#running = undefined;
		this.#abort = undefined;
		this.#relist = undefined;
		this.#synchronized.clear();
		this.#workspaceOwners.clear();
	}

	async #prepareSnapshot(snapshot: InfrastructureList, signal: AbortSignal): Promise<void> {
		await this.#reconcileLegacySessionAnnotations(snapshot.sessions, signal);
		const workspaceOwners = new Map<string, string>();
		for (const workspace of snapshot.workspaces) {
			const workspaceId = this.#requiredString(workspace.metadata.name, "workspace name");
			const owner = this.#requiredString(workspace.spec?.owner, "workspace owner");
			workspaceOwners.set(workspaceId, owner);
		}
		const ingress = this.#options.statusIngress;
		let ingressAvailable = ingress !== undefined;
		if (ingress) {
			for (const workspace of snapshot.workspaces) {
				if (signal.aborted) throw signal.reason;
				if (ingressAvailable) ingressAvailable = await this.#emitStatus("t4workspaces", this.#statusObservation("t4workspaces", workspace, workspaceOwners));
			}
			for (const session of snapshot.sessions) {
				if (signal.aborted) throw signal.reason;
				if (ingressAvailable) ingressAvailable = await this.#emitStatus("t4sessions", this.#statusObservation("t4sessions", session, workspaceOwners));
			}
			if (ingressAvailable) ingressAvailable = await this.#emitStatus("t4workspaces", {
				relisted: true,
				resourceVersion: this.#requiredString(snapshot.resourceVersions?.t4workspaces ?? snapshot.resourceVersion, "workspace list resourceVersion"),
				resourceIds: [...workspaceOwners.keys()],
			});
			if (ingressAvailable) await this.#emitStatus("t4sessions", {
				relisted: true,
				resourceVersion: this.#requiredString(snapshot.resourceVersions?.t4sessions ?? snapshot.resourceVersion, "session list resourceVersion"),
				resourceIds: snapshot.sessions.map(session => this.#requiredString(session.metadata.name, "session name")),
			});
		}
		this.#workspaceOwners.clear();
		for (const [workspaceId, owner] of workspaceOwners) this.#workspaceOwners.set(workspaceId, owner);
	}

	async #reconcileLegacySessionAnnotations(sessions: readonly KubernetesResource[], signal: AbortSignal): Promise<void> {
		for (const session of sessions) {
			const annotations = session.metadata.annotations;
			if (!annotations || !Object.prototype.hasOwnProperty.call(annotations, "cluster.t4.dev/pending-command")) continue;
			const resourceVersion = this.#requiredString(session.metadata.resourceVersion, "session resourceVersion");
			await this.#options.client.patch("t4sessions", session.metadata.name, {
				metadata: {
					resourceVersion,
					annotations: { "cluster.t4.dev/pending-command": null },
				},
			}, signal);
		}
	}

	#statusObservation(
		collection: KubernetesStatusCollection,
		resource: KubernetesResource,
		workspaceOwners: ReadonlyMap<string, string>,
		deleted = false,
	): AuthoritativeKubernetesStatusObservation {
		const expectedKind = collection === "t4workspaces" ? "T4Workspace" : "T4Session";
		if (resource.kind !== expectedKind) throw new Error(`Kubernetes ${collection} status kind is invalid`);
		const generation = resource.metadata.generation;
		if (generation === undefined || !Number.isSafeInteger(generation) || generation < 1)
			throw new Error(`Kubernetes ${collection} generation is invalid`);
		const observedGeneration = resource.status?.observedGeneration ?? 0;
		if (typeof observedGeneration !== "number" || !Number.isSafeInteger(observedGeneration)
			|| observedGeneration < 0 || observedGeneration > generation)
			throw new Error(`Kubernetes ${collection} observedGeneration is invalid`);
		const rawPhase = deleted || resource.metadata.deletionTimestamp
			? "Terminating"
			: resource.status?.phase;
		const phase = collection === "t4workspaces"
			? rawPhase === "Pending" || rawPhase === "Ready" || rawPhase === "Failed" || rawPhase === "Terminating" ? rawPhase : "Unknown"
			: rawPhase === "Pending" || rawPhase === "Running" || rawPhase === "Failed" || rawPhase === "Terminating" ? rawPhase : "Unknown";
		const resourceId = this.#requiredString(resource.metadata.name, `${collection} name`);
		const uid = this.#requiredString(resource.metadata.uid, `${collection} UID`);
		const resourceVersion = this.#requiredString(resource.metadata.resourceVersion, `${collection} resourceVersion`);
		if (collection === "t4workspaces") {
			return {
				resourceId,
				principalId: this.#requiredString(resource.spec?.owner, "workspace owner"),
				uid,
				resourceVersion,
				generation: BigInt(generation),
				observedGeneration: BigInt(observedGeneration),
				phase,
				...(deleted ? { deleted: true } : {}),
			};
		}
		const workspaceId = this.#requiredString(resource.spec?.workspaceRef, "session workspace reference");
		return {
			resourceId,
			principalId: this.#requiredString(workspaceOwners.get(workspaceId), "session workspace owner"),
			workspaceId,
			uid,
			resourceVersion,
			generation: BigInt(generation),
			observedGeneration: BigInt(observedGeneration),
			phase,
			...(deleted ? { deleted: true } : {}),
		};
	}

	#requiredString(value: unknown, name: string): string {
		if (typeof value !== "string" || value.length === 0) throw new Error(`Kubernetes ${name} is invalid`);
		return value;
	}

	#statusIngressLeaseUnavailable(error: unknown): boolean {
		return error instanceof Error && (
			error.message === "outbox lease is held by another owner"
			|| error.message === "Kubernetes status owner lease is no longer current"
		);
	}

	async #emitStatus(collection: KubernetesStatusCollection, observation: AuthoritativeKubernetesStatusIngress): Promise<boolean> {
		const ingress = this.#options.statusIngress;
		if (!ingress) return false;
		try {
			await ingress(collection, observation);
			return true;
		} catch (error) {
			if (this.#statusIngressLeaseUnavailable(error)) return false;
			throw error;
		}
	}

	async #ingestWatchStatus(collection: KubernetesStatusCollection, event: KubernetesWatchEvent): Promise<void> {
		if (this.#options.statusIngress) {
			await this.#emitStatus(collection, this.#statusObservation(collection, event.object, this.#workspaceOwners, event.type === "DELETED"));
		}
		if (collection === "t4workspaces") {
			const workspaceId = this.#requiredString(event.object.metadata.name, "workspace name");
			if (event.type === "DELETED") this.#workspaceOwners.delete(workspaceId);
			else {
				const owner = this.#requiredString(event.object.spec?.owner, "workspace owner");
				this.#workspaceOwners.set(workspaceId, owner);
			}
		}
	}

	async #run(signal: AbortSignal): Promise<void> {
		const resources = ["t4clusterhosts", "t4workspaces", "t4sessions"] as const;
		while (!signal.aborted) {
			const generation = new AbortController();
			const stopGeneration = (): void => generation.abort(signal.reason);
			signal.addEventListener("abort", stopGeneration, { once: true });
			await Promise.all(resources.map(resource => this.#watchResource(resource, resources.length, signal, generation)));
			signal.removeEventListener("abort", stopGeneration);
		}
	}

	async #watchResource(
		resource: string,
		resourceCount: number,
		rootSignal: AbortSignal,
		generation: AbortController,
	): Promise<void> {
		let version = this.#options.projection.resourceVersionFor(resource);
		const statusCollection = resource === "t4workspaces" || resource === "t4sessions" ? resource : undefined;
		while (!generation.signal.aborted) {
			let pendingStatus = Promise.resolve();
			let statusFailed = false;
			let statusError: unknown;
			const applyEvent = (event: KubernetesWatchEvent): void => {
				this.#options.projection.applyWatch(event);
				version = event.object.metadata.resourceVersion ?? version;
			};
			const onEvent = this.#options.statusIngress && statusCollection
				? (event: KubernetesWatchEvent): void => {
					pendingStatus = pendingStatus.then(async () => {
						if (statusFailed) return;
						await this.#ingestWatchStatus(statusCollection, event);
						applyEvent(event);
					}).catch(error => {
						statusFailed = true;
						statusError = error;
						generation.abort(error);
					});
				}
				: applyEvent;
			try {
				await this.#options.client.watch(
					resource,
					version,
					onEvent,
					generation.signal,
					() => {
						this.#synchronized.add(resource);
						if (this.#synchronized.size === resourceCount) this.#options.onSynchronized?.();
					},
				);
				await pendingStatus;
				if (statusFailed) throw statusError;
				if (generation.signal.aborted) return;
				this.#synchronized.delete(resource);
				this.#options.onError?.(new Error(`Kubernetes ${resource} watch ended`));
			} catch (watchError) {
				await pendingStatus;
				const error = statusFailed ? statusError : watchError;
				if (rootSignal.aborted || generation.signal.aborted && !statusFailed) return;
				this.#synchronized.delete(resource);
				this.#options.onError?.(error);
				const requiresRelist = statusFailed
					|| error instanceof KubernetesAuthorityInvalidatedError
					|| error instanceof KubernetesApiError && error.status === 410;
				if (requiresRelist) {
					try { await this.#restartGeneration(generation, rootSignal); }
					catch (relistError) {
						if (!rootSignal.aborted) this.#options.onError?.(relistError);
					}
					return;
				}
			}
			try { await delay(this.#options.retryMs ?? 1_000, generation.signal); }
			catch { return; }
		}
	}

	async #restartGeneration(generation: AbortController, signal: AbortSignal): Promise<void> {
		if (!this.#relist) {
			this.#synchronized.clear();
			generation.abort(new Error("Kubernetes watch generation relisting"));
			this.#relist = (async () => {
				while (!signal.aborted) {
					try {
						const snapshot = await this.#options.client.listInfrastructure(this.#options.hostName, signal);
						await this.#prepareSnapshot(snapshot, signal);
						this.#options.projection.replace(snapshot);
						return;
					} catch (error) {
						if (signal.aborted) throw error;
						this.#options.onError?.(error);
						await delay(this.#options.retryMs ?? 1_000, signal);
					}
				}
				throw signal.reason;
			})().finally(() => { this.#relist = undefined; });
		}
		await this.#relist;
	}
}
