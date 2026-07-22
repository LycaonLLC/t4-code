import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLUSTER_INTERNAL_AUDIENCE,
	KubernetesApiClient,
	KubernetesGatewayMutationBackend,
	KubernetesTokenReviewer,
	semanticResourceHash,
} from "../src/kubernetes-client.ts";
import { PublicKubernetesOutboxApplier } from "../src/public-kubernetes-applier.ts";
import type { OutboxMutation } from "../src/outbox-worker.ts";

const PRINCIPAL = "owner@example.com";

function recordingFetch(responses: unknown[]) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return Response.json(responses.shift() ?? {}, { status: init?.method === "POST" ? 201 : 200 });
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

function conflictFetch(existing: unknown) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return requests.length === 1
			? Response.json({ reason: "AlreadyExists" }, { status: 409 })
			: Response.json(existing);
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

describe("namespaced Kubernetes client", () => {
	it("lists and watches only the three cluster.t4.dev resources with bounded resource versions", async () => {
		const values = recordingFetch([
			{
				metadata: { resourceVersion: "20" },
				items: [{ apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4ClusterHost", metadata: { name: "primary", uid: "host-uid", resourceVersion: "20" }, spec: {} }],
			},
			{ metadata: { resourceVersion: "21" }, items: [] },
			{ metadata: { resourceVersion: "22" }, items: [] },
		]);
		const client = new KubernetesApiClient({
			baseUrl: "https://kubernetes.default.svc",
			namespace: "development",
			token: "service-account-token",
			fetch: values.fetch,
		});
		const listed = await client.listInfrastructure();
		expect(listed.resourceVersion).toBe("22");
		expect(values.requests.map(request => request.url)).toEqual([
			"https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4clusterhosts?limit=256",
			"https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4workspaces?limit=256",
			"https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4sessions?limit=1000",
		]);
		for (const request of values.requests) {
			expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer service-account-token");
		}
		expect(JSON.stringify(listed)).not.toContain("service-account-token");
	});

	it("observes projected service account token rotation without recreating the client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-kubernetes-client-token-"));
		try {
			const tokenFile = join(directory, "token");
			const nextTokenFile = join(directory, "token.next");
			const values = recordingFetch([{}, {}]);
			await writeFile(join(directory, "token-one"), "projected-token-one\n", { mode: 0o400 });
			await writeFile(join(directory, "token-two"), "projected-token-two\n", { mode: 0o400 });
			await symlink(join(directory, "token-one"), tokenFile);
			const client = new KubernetesApiClient({
				baseUrl: "https://kubernetes.default.svc",
				namespace: "development",
				tokenFile,
				fetch: values.fetch,
			});

			await client.list("t4clusterhosts", 1);
			await symlink(join(directory, "token-two"), nextTokenFile);
			await rename(nextTokenFile, tokenFile);
			await client.list("t4clusterhosts", 1);

			expect(values.requests.map(request => new Headers(request.init?.headers).get("authorization"))).toEqual([
				"Bearer projected-token-one",
				"Bearer projected-token-two",
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("requires exactly one bounded valid credential source and fails closed", async () => {
		const common = { baseUrl: "https://kubernetes.default.svc", namespace: "development" } as const;
		expect(() => new KubernetesApiClient(common)).toThrow("exactly one credential source");
		expect(() => new KubernetesApiClient({ ...common, token: "static-token", tokenFile: "/projected/token" })).toThrow("exactly one credential source");
		expect(() => new KubernetesApiClient({ ...common, tokenFile: "relative/token" })).toThrow("must be absolute");
		expect(() => new KubernetesApiClient({ ...common, token: "malformed token" })).toThrow("token is invalid");

		const directory = await mkdtemp(join(tmpdir(), "t4-kubernetes-client-invalid-token-"));
		try {
			const tokenFile = join(directory, "token");
			const nextTokenFile = join(directory, "token.next");
			const values = recordingFetch([]);
			const client = new KubernetesApiClient({ ...common, tokenFile, fetch: values.fetch });
			await writeFile(nextTokenFile, "malformed token", { mode: 0o400 });
			await rename(nextTokenFile, tokenFile);
			await expect(client.request("/version")).rejects.toThrow("Kubernetes token file is invalid");
			await writeFile(nextTokenFile, "x".repeat(16_385), { mode: 0o400 });
			await rename(nextTokenFile, tokenFile);
			await expect(client.request("/version")).rejects.toThrow("Kubernetes token file is invalid");
			expect(values.requests).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("persists idempotent CR identity as command id plus semantic hash without credentials or arbitrary URLs", async () => {
		const values = recordingFetch([
			{},
			{ kind: "T4Workspace", metadata: { name: "workspace-one" }, spec: { hostRef: "primary", owner: PRINCIPAL } },
		]);
		const client = new KubernetesApiClient({
			baseUrl: "https://kubernetes.default.svc",
			namespace: "development",
			token: "service-account-token",
			fetch: values.fetch,
		});
		const backend = new KubernetesGatewayMutationBackend({ client, hostRef: "primary" });
		const workspaceArgs = {
			displayName: "Created workspace",
			retentionPolicy: "Retain" as const,
			capacity: "20Gi",
			repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
		};
		await backend.createWorkspace("command-create-workspace", workspaceArgs, PRINCIPAL);
		const workspaceBody = JSON.parse(String(values.requests[0]?.init?.body));
		expect(values.requests[0]).toMatchObject({
			url: "https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4workspaces",
			init: { method: "POST" },
		});
		expect(workspaceBody).toMatchObject({
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: {
				name: expect.stringMatching(/^workspace-[a-f0-9]{16}$/),
				annotations: {
					"cluster.t4.dev/command-id": "command-create-workspace",
					"cluster.t4.dev/principal-hash": semanticResourceHash(PRINCIPAL),
					"cluster.t4.dev/semantic-hash": semanticResourceHash({ args: workspaceArgs, principal: PRINCIPAL }),
				},
			},
			spec: {
				hostRef: "primary",
				owner: PRINCIPAL,
				displayName: "Created workspace",
				retentionPolicy: "Retain",
				size: "20Gi",
				repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
			},
		});
		expect(JSON.stringify(workspaceBody)).not.toContain("token");
		expect(JSON.stringify(workspaceBody)).not.toContain("url");

		await backend.createSession("command-create-session", {
			workspaceId: "workspace-one",
			title: "Task",
			runtimeProfile: "omp-17.0.5",
			guiEnabled: true,
			ci: { provider: "woodpecker", repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
		}, PRINCIPAL);
		const sessionBody = JSON.parse(String(values.requests[2]?.init?.body));
		expect(sessionBody).toMatchObject({
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name: expect.stringMatching(/^session-[a-f0-9]{16}$/) },
			spec: { hostRef: "primary", workspaceRef: "workspace-one", title: "Task", runtimeProfile: "omp-17.0.5", guiEnabled: true },
		});
	});

	it("reuses exact principal-scoped annotations and rejects semantic conflicts", async () => {
		const args = { displayName: "Created", retentionPolicy: "Delete" as const, capacity: "10Gi" };
		const annotations = {
			"cluster.t4.dev/command-id": "command-one",
			"cluster.t4.dev/principal-hash": semanticResourceHash(PRINCIPAL),
			"cluster.t4.dev/semantic-hash": semanticResourceHash({ args, principal: PRINCIPAL }),
		};
		const existing = {
			metadata: { name: "workspace-existing", resourceVersion: "9", annotations },
			status: { revision: "workspace-r1" },
		};
		const exact = conflictFetch(existing);
		const backend = new KubernetesGatewayMutationBackend({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: exact.fetch }),
			hostRef: "primary",
		});
		expect(await backend.createWorkspace("command-one", args, PRINCIPAL)).toEqual({ id: "workspace-existing", revision: "9" });
		expect(exact.requests.map(request => request.init?.method ?? "GET")).toEqual(["POST", "GET"]);

		const conflicting = conflictFetch({ ...existing, metadata: { ...existing.metadata, annotations: { ...annotations, "cluster.t4.dev/semantic-hash": "wrong" } } });
		const conflictingBackend = new KubernetesGatewayMutationBackend({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: conflicting.fetch }),
			hostRef: "primary",
		});
		await expect(conflictingBackend.createWorkspace("command-one", args, PRINCIPAL)).rejects.toThrow("idempotency conflict");
	});

	it("treats an already absent session as a successful idempotent delete", async () => {
		const fetch = (async () => Response.json({ reason: "NotFound" }, { status: 404 })) as unknown as typeof globalThis.fetch;
		const backend = new KubernetesGatewayMutationBackend({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch }),
			hostRef: "primary",
		});
		expect(await backend.deleteSession("command-delete", "session-gone", PRINCIPAL)).toEqual({ deleted: true });
	});
});

describe("durable public Kubernetes applier", () => {
	const fence = { ownerId: "worker-a", epoch: 7n };
	const workspaceMutation: OutboxMutation = {
		idempotencyToken: "outbox:41",
		commandId: "command-41",
		principalId: PRINCIPAL,
		kind: "workspace.patch",
		targetId: "workspace-one",
		targetRevision: 2n,
		payload: { id: "workspace-one", name: "patched", revision: 2 },
	};
	const priorAnnotations = {
		"cluster.t4.dev/ledger-command-id": "prior-command",
		"cluster.t4.dev/ledger-outbox-token": "outbox:prior",
		"cluster.t4.dev/ledger-owner": "prior-worker",
		"cluster.t4.dev/ledger-owner-epoch": "6",
		"cluster.t4.dev/ledger-semantic-hash": "sha256:prior",
	};

	it("carries observed resourceVersion and owner epoch on every existing-resource PATCH", async () => {
		const values = recordingFetch([{
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: { name: "workspace-one", resourceVersion: "41", annotations: priorAnnotations },
			spec: { hostRef: "primary", owner: PRINCIPAL, displayName: "old" },
		}, {}]);
		const applier = new PublicKubernetesOutboxApplier({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: values.fetch }),
			hostRef: "primary",
		});
		await applier.apply(workspaceMutation, fence);
		const patch = JSON.parse(String(values.requests[1]?.init?.body));
		expect(patch.metadata).toMatchObject({
			resourceVersion: "41",
			annotations: {
				"cluster.t4.dev/ledger-owner": "worker-a",
				"cluster.t4.dev/ledger-owner-epoch": "7",
			},
		});
	});

	it("lets Kubernetes reject a paused stale resourceVersion after a current-owner mutation", async () => {
		let actualVersion = "51";
		const patchStarted = Promise.withResolvers<void>();
		const releasePatch = Promise.withResolvers<void>();
		const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method !== "PATCH") return Response.json({
				apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace",
				metadata: { name: "workspace-one", resourceVersion: "51", annotations: priorAnnotations },
				spec: { hostRef: "primary", owner: PRINCIPAL },
			});
			patchStarted.resolve();
			await releasePatch.promise;
			const body = JSON.parse(String(init.body));
			return body.metadata?.resourceVersion === actualVersion
				? Response.json({ metadata: { resourceVersion: "52" } })
				: Response.json({ reason: "Conflict" }, { status: 409 });
		}) as typeof globalThis.fetch;
		const applier = new PublicKubernetesOutboxApplier({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch }),
			hostRef: "primary",
		});
		const stale = applier.apply(workspaceMutation, fence);
		await patchStarted.promise;
		actualVersion = "52";
		releasePatch.resolve();
		await expect(stale).rejects.toMatchObject({ status: 409 });
	});

	it("validates full kind, host, principal relation, and ledger identity on create-409 replay", async () => {
		const createMutation: OutboxMutation = {
			...workspaceMutation,
			kind: "workspace.create",
			payload: { id: "workspace-one", name: "created", revision: 1 },
		};
		const requiredAnnotations = {
			"cluster.t4.dev/ledger-command-id": createMutation.commandId,
			"cluster.t4.dev/ledger-outbox-token": createMutation.idempotencyToken,
			"cluster.t4.dev/ledger-owner": fence.ownerId,
			"cluster.t4.dev/ledger-owner-epoch": fence.epoch.toString(),
			"cluster.t4.dev/ledger-semantic-hash": semanticResourceHash(createMutation.payload),
		};
		const exactExisting = {
			apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace",
			metadata: { name: "workspace-one", resourceVersion: "9", annotations: requiredAnnotations },
			spec: { hostRef: "primary", owner: PRINCIPAL, displayName: "created" },
		};
		const exact = conflictFetch(exactExisting);
		await new PublicKubernetesOutboxApplier({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: exact.fetch }),
			hostRef: "primary",
		}).apply(createMutation, fence);

		for (const conflicting of [
			{ ...exactExisting, kind: "T4Session" },
			{ ...exactExisting, spec: { ...exactExisting.spec, hostRef: "other" } },
			{ ...exactExisting, spec: { ...exactExisting.spec, owner: "other@example.com" } },
			{ ...exactExisting, metadata: { ...exactExisting.metadata, annotations: { ...requiredAnnotations, "cluster.t4.dev/ledger-command-id": "copied-wrong-command" } } },
		]) {
			const values = conflictFetch(conflicting);
			const applier = new PublicKubernetesOutboxApplier({
				client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: values.fetch }),
				hostRef: "primary",
			});
			await expect(applier.apply(createMutation, fence)).rejects.toThrow("conflict");
		}
	});

	it("rejects patching existing resources with missing ledger identity or the wrong API kind", async () => {
		for (const existing of [
			{ apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace", metadata: { name: "workspace-one", resourceVersion: "8", annotations: { "cluster.t4.dev/ledger-owner-epoch": "6" } }, spec: { hostRef: "primary", owner: PRINCIPAL } },
			{ apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Session", metadata: { name: "workspace-one", resourceVersion: "8", annotations: priorAnnotations }, spec: { hostRef: "primary", owner: PRINCIPAL } },
		]) {
			const values = recordingFetch([existing]);
			const applier = new PublicKubernetesOutboxApplier({
				client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: values.fetch }),
				hostRef: "primary",
			});
			await expect(applier.apply(workspaceMutation, fence)).rejects.toThrow("identity");
			expect(values.requests).toHaveLength(1);
		}
	});
	it("uses the configured host-admitted runtime profile for durable session creation", async () => {
		const values = recordingFetch([{}]);
		const options = {
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: values.fetch }),
			hostRef: "primary",
			runtimeProfile: "review-admitted",
		};
		const applier = new PublicKubernetesOutboxApplier(options);
		await applier.apply({
			...workspaceMutation,
			kind: "session.create",
			targetId: "session-one",
			payload: { id: "session-one", workspaceId: "workspace-one", title: "session", revision: 1 },
		}, fence);
		const created = JSON.parse(String(values.requests[0]?.init?.body));
		expect(created.spec.runtimeProfile).toBe("review-admitted");
	});

	it("projects only a bounded durable command pointer and keeps command payload in PostgreSQL", async () => {
		const secretCommand = `printf ${"secret-payload".repeat(8_192)}`;
		const values = recordingFetch([{
			apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Session",
			metadata: { name: "session-one", resourceVersion: "61", annotations: { "cluster.t4.dev/ledger-owner-epoch": "6" } },
			spec: { hostRef: "primary", workspaceRef: "workspace-one" },
		}, {
			apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace",
			metadata: { name: "workspace-one", resourceVersion: "60" },
			spec: { hostRef: "primary", owner: PRINCIPAL },
		}, {}]);
		const applier = new PublicKubernetesOutboxApplier({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: values.fetch }),
			hostRef: "primary",
		});
		const commandMutation: OutboxMutation = {
			...workspaceMutation,
			kind: "command.submit",
			targetId: "session-one",
			payload: { sessionId: "session-one", command: secretCommand, metadata: { secret: "never-project" } },
		};
		await applier.apply(commandMutation, fence);
		const patchRequest = values.requests.at(-1)!;
		const patch = JSON.parse(String(patchRequest.init?.body));
		expect(patch.metadata.annotations["cluster.t4.dev/pending-command-id"]).toBe(commandMutation.commandId);
		expect(patch.metadata.annotations["cluster.t4.dev/pending-command-epoch"]).toBe(fence.epoch.toString());
		expect(JSON.stringify(patch)).not.toContain("secret-payload");
		expect(JSON.stringify(patch)).not.toContain("never-project");
		expect(new TextEncoder().encode(JSON.stringify(patch.metadata)).byteLength).toBeLessThan(4_096);
	});

	it("verifies a session kind and its owning workspace relation before patching", async () => {
		const values = recordingFetch([{
			apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Session",
			metadata: { name: "session-one", resourceVersion: "71", annotations: {
				"cluster.t4.dev/ledger-command-id": "prior-command",
				"cluster.t4.dev/ledger-outbox-token": "outbox:prior",
				"cluster.t4.dev/ledger-owner": "prior-worker",
				"cluster.t4.dev/ledger-owner-epoch": "6",
				"cluster.t4.dev/ledger-semantic-hash": "sha256:prior",
			} },
			spec: { hostRef: "primary", workspaceRef: "workspace-one" },
		}, {
			apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace",
			metadata: { name: "workspace-one", resourceVersion: "70" },
			spec: { hostRef: "primary", owner: PRINCIPAL },
		}, {}]);
		const applier = new PublicKubernetesOutboxApplier({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: values.fetch }),
			hostRef: "primary",
		});
		await applier.apply({
			...workspaceMutation,
			kind: "session.patch",
			targetId: "session-one",
			payload: { id: "session-one", workspaceId: "workspace-one", title: "patched", revision: 2 },
		}, fence);
		expect(values.requests.map(value => value.init?.method ?? "GET")).toEqual(["GET", "GET", "PATCH"]);
		expect(values.requests[1]?.url).toContain("/t4workspaces/workspace-one");
	});
});

describe("Kubernetes projected identity review", () => {
	it("submits the presented bearer with the fixed audience and requires the exact server ServiceAccount", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-token-review-"));
		try {
			await writeFile(join(directory, "token"), "reviewer-api-token", { mode: 0o400 });
			await writeFile(join(directory, "ca.crt"), "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o400 });
			await writeFile(join(directory, "namespace"), "team\n", { mode: 0o400 });
			const presentedToken = `header.payload.${"s".repeat(64)}`;
			const requests: Array<{ url: string; init?: RequestInit }> = [];
			const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return Response.json({
					apiVersion: "authentication.k8s.io/v1",
					kind: "TokenReview",
					status: {
						authenticated: true,
						audiences: [CLUSTER_INTERNAL_AUDIENCE],
						user: { username: "system:serviceaccount:team:release-t4-cluster-server" },
					},
				});
			}) as typeof globalThis.fetch;
			const reviewer = new KubernetesTokenReviewer({
				baseUrl: "https://kubernetes.default.svc",
				tokenPath: join(directory, "token"),
				caPath: join(directory, "ca.crt"),
				namespacePath: join(directory, "namespace"),
				serverServiceAccountName: "release-t4-cluster-server",
				fetch,
			});
			expect(await reviewer.review(presentedToken)).toBe(true);
			expect(requests[0]?.url).toBe("https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews");
			expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer reviewer-api-token");
			expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
				apiVersion: "authentication.k8s.io/v1",
				kind: "TokenReview",
				spec: { token: presentedToken, audiences: ["t4-cluster-internal"] },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("denies malformed, rejected, wrong-audience, wrong-username, API-status, and network responses", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-token-review-denied-"));
		try {
			await writeFile(join(directory, "token"), "reviewer-api-token", { mode: 0o400 });
			await writeFile(join(directory, "ca.crt"), "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o400 });
			await writeFile(join(directory, "namespace"), "team", { mode: 0o400 });
			const presentedToken = `header.payload.${"s".repeat(64)}`;
			const statuses: unknown[] = [
				{ authenticated: false },
				{ authenticated: true, audiences: ["other"], user: { username: "system:serviceaccount:team:release-t4-cluster-server" } },
				{ authenticated: true, audiences: [CLUSTER_INTERNAL_AUDIENCE], user: { username: "system:serviceaccount:other:release-t4-cluster-server" } },
				{ authenticated: true, audiences: [CLUSTER_INTERNAL_AUDIENCE] },
				{ authenticated: true, error: "review failed", audiences: [CLUSTER_INTERNAL_AUDIENCE], user: { username: "system:serviceaccount:team:release-t4-cluster-server" } },
			];
			for (const status of statuses) {
				const reviewer = new KubernetesTokenReviewer({
					baseUrl: "https://kubernetes.default.svc",
					tokenPath: join(directory, "token"),
					caPath: join(directory, "ca.crt"),
					namespacePath: join(directory, "namespace"),
					serverServiceAccountName: "release-t4-cluster-server",
					fetch: (async () => Response.json({ apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", status })) as unknown as typeof globalThis.fetch,
				});
				expect(await reviewer.review(presentedToken)).toBe(false);
			}
			const malformed = new KubernetesTokenReviewer({
				baseUrl: "https://kubernetes.default.svc",
				tokenPath: join(directory, "token"), caPath: join(directory, "ca.crt"), namespacePath: join(directory, "namespace"),
				serverServiceAccountName: "release-t4-cluster-server",
				fetch: (async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch,
			});
			expect(await malformed.review(presentedToken)).toBe(false);
			const unavailable = new KubernetesTokenReviewer({
				baseUrl: "https://kubernetes.default.svc",
				tokenPath: join(directory, "token"), caPath: join(directory, "ca.crt"), namespacePath: join(directory, "namespace"),
				serverServiceAccountName: "release-t4-cluster-server",
				fetch: (async () => { throw new Error("network unavailable"); }) as unknown as typeof globalThis.fetch,
			});
			expect(await unavailable.review(presentedToken)).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
