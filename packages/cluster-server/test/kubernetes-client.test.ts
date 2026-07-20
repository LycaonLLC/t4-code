import { describe, expect, test } from "vite-plus/test"
import {
	KubernetesApiClient,
	KubernetesGatewayMutationBackend,
	semanticResourceHash,
} from "../src/kubernetes-client.ts";

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
	test("lists and watches only the three cluster.t4.dev resources with bounded resource versions", async () => {
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

	test("persists idempotent CR identity as command id plus semantic hash without credentials or arbitrary URLs", async () => {
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
			storageClass: "t4-workspaces-rwx",
			repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abc" },
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
				storageClassName: "t4-workspaces-rwx",
				repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abc" },
			},
		});
		expect(JSON.stringify(workspaceBody)).not.toContain("token");
		expect(JSON.stringify(workspaceBody)).not.toContain("url");

		await backend.createSession("command-create-session", {
			workspaceId: "workspace-one",
			title: "Task",
			runtimeProfile: "omp-17.0.5",
			guiEnabled: true,
			ci: { provider: "woodpecker", repositoryId: "t4-code", ref: "refs/heads/main", commit: "abc" },
		}, PRINCIPAL);
		const sessionBody = JSON.parse(String(values.requests[2]?.init?.body));
		expect(sessionBody).toMatchObject({
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name: expect.stringMatching(/^session-[a-f0-9]{16}$/) },
			spec: { hostRef: "primary", workspaceRef: "workspace-one", title: "Task", runtimeProfile: "omp-17.0.5", guiEnabled: true },
		});
	});

	test("reuses exact principal-scoped annotations and rejects semantic conflicts", async () => {
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
});
