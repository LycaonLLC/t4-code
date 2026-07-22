import { semanticResourceHash, KubernetesApiClient, KubernetesApiError } from "./kubernetes-client.ts";
import type { KubernetesResource } from "./kubernetes-projection.ts";
import type {
	KubernetesOutboxApplier,
	OutboxApplyContext,
	OutboxMutation,
	StaleCreateCleanup,
	StaleCreateCleanupReplayContext,
} from "./outbox-worker.ts";
import type { OwnerLease } from "./ledger.ts";

export interface PublicKubernetesOutboxApplierOptions {
	readonly client: KubernetesApiClient;
	readonly hostRef: string;
	readonly runtimeProfile?: string;
}

type ResourceType = "t4workspaces" | "t4sessions";
const API_VERSION = "cluster.t4.dev/v1alpha1";
const LEDGER_ANNOTATIONS = [
	"cluster.t4.dev/ledger-command-id",
	"cluster.t4.dev/ledger-outbox-token",
	"cluster.t4.dev/ledger-owner",
	"cluster.t4.dev/ledger-owner-epoch",
	"cluster.t4.dev/ledger-semantic-hash",
] as const;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function boundedAnnotation(name: string, value: string): string {
	if (!value || new TextEncoder().encode(value).byteLength > 256) throw new Error(`${name} is invalid`);
	return value;
}
function annotations(mutation: OutboxMutation, fence: OwnerLease): Record<string, string> {
	if (fence.epoch < 0n) throw new Error("ledger owner epoch is invalid");
	return {
		"cluster.t4.dev/ledger-command-id": boundedAnnotation("ledger command id", mutation.commandId),
		"cluster.t4.dev/ledger-outbox-token": boundedAnnotation("ledger outbox token", mutation.idempotencyToken),
		"cluster.t4.dev/ledger-owner": boundedAnnotation("ledger owner", fence.ownerId),
		"cluster.t4.dev/ledger-owner-epoch": fence.epoch.toString(),
		"cluster.t4.dev/ledger-semantic-hash": semanticResourceHash(mutation.payload),
	};
}
function assertResourceIdentity(resource: KubernetesResource, resourceType: ResourceType, name: string): void {
	const kind = resourceType === "t4workspaces" ? "T4Workspace" : "T4Session";
	if (resource.apiVersion !== API_VERSION || resource.kind !== kind || resource.metadata?.name !== name)
		throw new Error("Kubernetes resource identity is invalid");
}
function assertLedgerIdentity(resource: KubernetesResource, fence: OwnerLease): void {
	const values = resource.metadata.annotations;
	if (!values || LEDGER_ANNOTATIONS.some(key => typeof values[key] !== "string" || values[key].length === 0))
		throw new Error("Kubernetes ledger identity is invalid");
	const epoch = values["cluster.t4.dev/ledger-owner-epoch"]!;
	if (!/^(?:0|[1-9][0-9]*)$/u.test(epoch)) throw new Error("Kubernetes ledger identity is invalid");
	const ownerEpoch = BigInt(epoch);
	if (ownerEpoch > fence.epoch || ownerEpoch === fence.epoch && values["cluster.t4.dev/ledger-owner"] !== fence.ownerId)
		throw new Error("Kubernetes resource is fenced by another ledger owner");
}

export class PublicKubernetesOutboxApplier implements KubernetesOutboxApplier {
	readonly #client: KubernetesApiClient;
	readonly #hostRef: string;
	readonly #runtimeProfile: string;
	constructor(options: PublicKubernetesOutboxApplierOptions) {
		this.#client = options.client;
		this.#hostRef = boundedAnnotation("Kubernetes host reference", options.hostRef);
		const runtimeProfile = options.runtimeProfile ?? "default";
		if (runtimeProfile.length > 64 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(runtimeProfile))
			throw new Error("Kubernetes runtime profile is invalid");
		this.#runtimeProfile = runtimeProfile;
	}

	async apply(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		if (mutation.kind === "workspace.create") return await this.#createWorkspace(mutation, fence, context);
		if (mutation.kind === "session.create") return await this.#createSession(mutation, fence, context);
		if (mutation.kind === "workspace.patch") return await this.#patchWorkspace(mutation, fence, context);
		if (mutation.kind === "session.patch") return await this.#patchSession(mutation, fence, context);
		if (mutation.kind === "command.submit") return await this.#submitCommand(mutation, fence, context);
		if (mutation.kind === "workspace.delete") return await this.#delete("t4workspaces", mutation, fence, context);
		return await this.#delete("t4sessions", mutation, fence, context);
	}

	async replayStaleCreateCleanup(cleanup: StaleCreateCleanup, context: StaleCreateCleanupReplayContext): Promise<void> {
		if (context.signal?.aborted) throw context.signal.reason;
		if (!await context.claimIsCurrent()) throw new Error("outbox lease is no longer current");
		if (context.signal?.aborted) throw context.signal.reason;
		let current: KubernetesResource;
		try {
			current = await this.#client.get(cleanup.resourceType, cleanup.targetId, context.signal);
		} catch (error) {
			if (error instanceof KubernetesApiError && error.status === 404) {
				if (!await context.claimIsCurrent()) throw new Error("outbox lease is no longer current");
				if (context.signal?.aborted) throw context.signal.reason;
				return;
			}
			throw error;
		}
		if (!await context.claimIsCurrent()) throw new Error("outbox lease is no longer current");
		if (context.signal?.aborted) throw context.signal.reason;
		if (current.metadata.uid !== cleanup.uid) return;
		assertResourceIdentity(current, cleanup.resourceType, cleanup.targetId);
		const resourceVersion = current.metadata.resourceVersion;
		if (!resourceVersion) throw new Error("Kubernetes stale-create cleanup resourceVersion is unavailable");
		try {
			await this.#client.delete(cleanup.resourceType, cleanup.targetId, { uid: cleanup.uid, resourceVersion }, context.signal);
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 404) throw error;
		}
	}

	async #assertCurrent(context?: OutboxApplyContext): Promise<void> {
		if (context?.signal?.aborted) throw context.signal.reason;
		if (context?.claimIsCurrent && !await context.claimIsCurrent()) throw new Error("outbox lease is no longer current");
		if (context?.signal?.aborted) throw context.signal.reason;
	}

	async #createWorkspace(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		const body = {
			apiVersion: API_VERSION,
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
		await this.#createIdempotently("t4workspaces", mutation, fence, body, context);
	}
	async #createSession(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		const workspaceId = String(mutation.payload.workspaceId);
		await this.#ownedWorkspace(workspaceId, mutation, fence, context?.signal);
		const body = {
			apiVersion: API_VERSION,
			kind: "T4Session",
			metadata: { name: mutation.targetId, annotations: annotations(mutation, fence) },
			spec: {
				hostRef: this.#hostRef,
				workspaceRef: workspaceId,
				title: String(mutation.payload.title),
				runtimeProfile: this.#runtimeProfile,
				guiEnabled: true,
			},
		};
		await this.#createIdempotently("t4sessions", mutation, fence, body, context);
	}
	async #patchWorkspace(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		const current = await this.#owned("t4workspaces", mutation, fence, context?.signal);
		const spec = record(current.spec);
		await this.#assertCurrent(context);
		await this.#client.patch("t4workspaces", mutation.targetId, {
			metadata: { resourceVersion: current.metadata.resourceVersion, annotations: annotations(mutation, fence) },
			spec: { ...spec, displayName: String(mutation.payload.name) },
		}, context?.signal);
	}
	async #patchSession(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		const current = await this.#owned("t4sessions", mutation, fence, context?.signal);
		await this.#assertCurrent(context);
		await this.#client.patch("t4sessions", mutation.targetId, {
			metadata: {
				resourceVersion: current.metadata.resourceVersion,
				annotations: { ...annotations(mutation, fence), "cluster.t4.dev/pending-command": null },
			},
			spec: { title: String(mutation.payload.title) },
		}, context?.signal);
	}
	async #submitCommand(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		const current = await this.#owned("t4sessions", mutation, fence, context?.signal);
		await this.#assertCurrent(context);
		await this.#client.patch("t4sessions", mutation.targetId, {
			metadata: {
				resourceVersion: current.metadata.resourceVersion,
				annotations: {
					...annotations(mutation, fence),
					"cluster.t4.dev/pending-command": null,
					"cluster.t4.dev/pending-command-id": boundedAnnotation("pending command id", mutation.commandId),
					"cluster.t4.dev/pending-command-epoch": fence.epoch.toString(),
				},
			},
		}, context?.signal);
	}
	async #delete(resourceType: ResourceType, mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void> {
		let current: KubernetesResource;
		try {
			current = await this.#owned(resourceType, mutation, fence, context?.signal);
		} catch (error) {
			if (error instanceof KubernetesApiError && error.status === 404) return;
			throw error;
		}
		if (!current.metadata.uid) throw new Error("Kubernetes delete precondition is unavailable");
		await this.#assertCurrent(context);
		try {
			await this.#client.delete(resourceType, mutation.targetId, { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion! }, context?.signal);
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 404) throw error;
		}
	}
	async #owned(resourceType: ResourceType, mutation: OutboxMutation, fence: OwnerLease, signal?: AbortSignal): Promise<KubernetesResource> {
		const current = await this.#client.get(resourceType, mutation.targetId, signal);
		assertResourceIdentity(current, resourceType, mutation.targetId);
		assertLedgerIdentity(current, fence);
		if (!current.metadata.resourceVersion) throw new Error("Kubernetes resource identity is missing resourceVersion");
		const spec = record(current.spec);
		if (spec.hostRef !== this.#hostRef) throw new Error("Kubernetes resource belongs to another cluster host");
		if (resourceType === "t4workspaces") {
			if (spec.owner !== mutation.principalId) throw new Error("Kubernetes workspace belongs to another principal");
		} else {
			const workspaceId = spec.workspaceRef;
			if (typeof workspaceId !== "string" || !workspaceId || mutation.payload.workspaceId !== undefined && mutation.payload.workspaceId !== workspaceId)
				throw new Error("Kubernetes session workspace identity is invalid");
			await this.#ownedWorkspace(workspaceId, mutation, fence, signal);
		}
		return current;
	}
	async #ownedWorkspace(workspaceId: string, mutation: OutboxMutation, fence: OwnerLease, signal?: AbortSignal): Promise<KubernetesResource> {
		const workspace = await this.#client.get("t4workspaces", workspaceId, signal);
		assertResourceIdentity(workspace, "t4workspaces", workspaceId);
		assertLedgerIdentity(workspace, fence);
		const spec = record(workspace.spec);
		if (spec.hostRef !== this.#hostRef || spec.owner !== mutation.principalId)
			throw new Error("Kubernetes workspace ownership identity is invalid");
		return workspace;
	}
	async #persistCreateCleanup(resourceType: ResourceType, targetId: string, created: KubernetesResource, context?: OutboxApplyContext): Promise<StaleCreateCleanup | undefined> {
		const uid = created.metadata?.uid;
		const resourceVersion = created.metadata?.resourceVersion;
		if (!uid || !resourceVersion) return undefined;
		assertResourceIdentity(created, resourceType, targetId);
		const cleanup: StaleCreateCleanup = { resourceType, targetId, uid, resourceVersion };
		await context?.persistStaleCreateCleanup?.(cleanup);
		return cleanup;
	}

	async #cleanupCreate(cleanup: StaleCreateCleanup): Promise<void> {
		try {
			await this.#client.delete(
				cleanup.resourceType,
				cleanup.targetId,
				{ uid: cleanup.uid, resourceVersion: cleanup.resourceVersion },
				AbortSignal.timeout(5_000),
			);
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 404) throw error;
		}
	}

	async #createIdempotently(resourceType: ResourceType, mutation: OutboxMutation, fence: OwnerLease, body: KubernetesResource, context?: OutboxApplyContext): Promise<void> {
		await this.#assertCurrent(context);
		let created: KubernetesResource;
		try {
			created = await this.#client.create(resourceType, body, context?.signal);
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 409) throw error;
			try {
				const current = await this.#client.get(resourceType, mutation.targetId, context?.signal);
				assertResourceIdentity(current, resourceType, mutation.targetId);
				assertLedgerIdentity(current, fence);
				if (!current.metadata.resourceVersion) throw new Error("resourceVersion conflict");
				const spec = record(current.spec);
				if (semanticResourceHash(spec) !== semanticResourceHash(body.spec)) throw new Error("spec conflict");
				if (spec.hostRef !== this.#hostRef) throw new Error("host conflict");
				if (resourceType === "t4workspaces" && spec.owner !== mutation.principalId) throw new Error("principal conflict");
				if (resourceType === "t4sessions" && spec.workspaceRef !== mutation.payload.workspaceId) throw new Error("workspace conflict");
				if (resourceType === "t4sessions") await this.#ownedWorkspace(String(spec.workspaceRef), mutation, fence, context?.signal);
				const currentAnnotations = current.metadata.annotations ?? {};
				const expectedAnnotations = annotations(mutation, fence);
				for (const key of ["cluster.t4.dev/ledger-command-id", "cluster.t4.dev/ledger-outbox-token", "cluster.t4.dev/ledger-semantic-hash"] as const) {
					if (currentAnnotations[key] !== expectedAnnotations[key]) throw new Error("ledger conflict");
				}
				await this.#assertCurrent(context);
				await this.#client.patch(resourceType, mutation.targetId, {
					metadata: { resourceVersion: current.metadata.resourceVersion, annotations: expectedAnnotations },
				}, context?.signal);
				await this.#assertCurrent(context);
				return;
			} catch {
				throw new Error("Kubernetes resource conflicts with durable ledger intent");
			}
		}
		const cleanup = await this.#persistCreateCleanup(resourceType, mutation.targetId, created, context);
		try {
			await this.#assertCurrent(context);
		} catch (error) {
			if (cleanup) await this.#cleanupCreate(cleanup);
			throw error;
		}
	}
}
