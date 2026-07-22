import { semanticResourceHash, KubernetesApiClient, KubernetesApiError } from "./kubernetes-client.ts";
import type { KubernetesResource } from "./kubernetes-projection.ts";
import type { KubernetesOutboxApplier, OutboxMutation } from "./outbox-worker.ts";
import type { OwnerLease } from "./ledger.ts";

export interface PublicKubernetesOutboxApplierOptions {
	readonly client: KubernetesApiClient;
	readonly hostRef: string;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function annotations(mutation: OutboxMutation, fence: OwnerLease): Record<string, string> {
	return {
		"cluster.t4.dev/ledger-command-id": mutation.commandId,
		"cluster.t4.dev/ledger-outbox-token": mutation.idempotencyToken,
		"cluster.t4.dev/ledger-owner": fence.ownerId,
		"cluster.t4.dev/ledger-owner-epoch": fence.epoch.toString(),
		"cluster.t4.dev/ledger-semantic-hash": semanticResourceHash(mutation.payload),
	};
}
function assertedEpoch(resource: KubernetesResource, fence: OwnerLease): void {
	const value = resource.metadata.annotations?.["cluster.t4.dev/ledger-owner-epoch"];
	if (value && /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) > fence.epoch) throw new Error("Kubernetes resource is fenced by a newer ledger owner");
}

export class PublicKubernetesOutboxApplier implements KubernetesOutboxApplier {
	readonly #client: KubernetesApiClient;
	readonly #hostRef: string;
	constructor(options: PublicKubernetesOutboxApplierOptions) {
		this.#client = options.client;
		this.#hostRef = options.hostRef;
	}

	async apply(mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		if (mutation.kind === "workspace.create") return await this.#createWorkspace(mutation, fence);
		if (mutation.kind === "session.create") return await this.#createSession(mutation, fence);
		if (mutation.kind === "workspace.patch") return await this.#patchWorkspace(mutation, fence);
		if (mutation.kind === "session.patch") return await this.#patchSession(mutation, fence);
		if (mutation.kind === "command.submit") return await this.#submitCommand(mutation, fence);
		if (mutation.kind === "workspace.delete") return await this.#delete("t4workspaces", mutation, fence);
		return await this.#delete("t4sessions", mutation, fence);
	}

	async #createWorkspace(mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		const body = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: { name: mutation.targetId, annotations: annotations(mutation, fence) },
			spec: {
				hostRef: this.#hostRef,
				owner: mutation.principalId,
				displayName: String(mutation.payload.name),
				retentionPolicy: "Retain",
				size: "20Gi",
			},
		};
		await this.#createIdempotently("t4workspaces", mutation, fence, body);
	}
	async #createSession(mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		const body = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name: mutation.targetId, annotations: annotations(mutation, fence) },
			spec: {
				hostRef: this.#hostRef,
				workspaceRef: String(mutation.payload.workspaceId),
				title: String(mutation.payload.title),
				runtimeProfile: "omp-default",
				guiEnabled: true,
			},
		};
		await this.#createIdempotently("t4sessions", mutation, fence, body);
	}
	async #patchWorkspace(mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		const current = await this.#owned("t4workspaces", mutation, fence);
		const spec = record(current.spec);
		await this.#client.patch("t4workspaces", mutation.targetId, {
			metadata: { annotations: annotations(mutation, fence) },
			spec: { ...spec, displayName: String(mutation.payload.name) },
		});
	}
	async #patchSession(mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		await this.#owned("t4sessions", mutation, fence);
		await this.#client.patch("t4sessions", mutation.targetId, {
			metadata: { annotations: annotations(mutation, fence) },
			spec: { title: String(mutation.payload.title) },
		});
	}
	async #submitCommand(mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		await this.#owned("t4sessions", mutation, fence);
		await this.#client.patch("t4sessions", mutation.targetId, {
			metadata: { annotations: { ...annotations(mutation, fence), "cluster.t4.dev/pending-command": JSON.stringify(mutation.payload) } },
		});
	}
	async #delete(resourceType: "t4workspaces" | "t4sessions", mutation: OutboxMutation, fence: OwnerLease): Promise<void> {
		let current: KubernetesResource;
		try { current = await this.#owned(resourceType, mutation, fence); }
		catch (error) {
			if (error instanceof KubernetesApiError && error.status === 404) return;
			throw error;
		}
		if (!current.metadata.uid || !current.metadata.resourceVersion) throw new Error("Kubernetes delete precondition is unavailable");
		try { await this.#client.delete(resourceType, mutation.targetId, { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion }); }
		catch (error) { if (!(error instanceof KubernetesApiError) || error.status !== 404) throw error; }
	}
	async #owned(resourceType: "t4workspaces" | "t4sessions", mutation: OutboxMutation, fence: OwnerLease): Promise<KubernetesResource> {
		const current = await this.#client.get(resourceType, mutation.targetId);
		assertedEpoch(current, fence);
		const spec = record(current.spec);
		if (spec.hostRef !== this.#hostRef) throw new Error("Kubernetes resource belongs to another cluster host");
		if (resourceType === "t4workspaces" && spec.owner !== mutation.principalId) throw new Error("Kubernetes workspace belongs to another principal");
		return current;
	}
	async #createIdempotently(resourceType: "t4workspaces" | "t4sessions", mutation: OutboxMutation, fence: OwnerLease, body: KubernetesResource): Promise<void> {
		try { await this.#client.create(resourceType, body); }
		catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 409) throw error;
			const current = await this.#client.get(resourceType, mutation.targetId);
			assertedEpoch(current, fence);
			const currentAnnotations = current.metadata.annotations ?? {};
			if (currentAnnotations["cluster.t4.dev/ledger-outbox-token"] !== mutation.idempotencyToken || currentAnnotations["cluster.t4.dev/ledger-semantic-hash"] !== semanticResourceHash(mutation.payload)) throw new Error("Kubernetes resource conflicts with durable ledger intent");
		}
	}
}
