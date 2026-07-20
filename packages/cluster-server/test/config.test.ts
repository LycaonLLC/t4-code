import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterServerConfigFromEnv, readClusterIdentityToken } from "../src/config.ts";

const BASE_ENV = {
	POD_NAMESPACE: "cluster-system",
	POD_NAME: "cluster-server-0",
	POD_UID: "12345678-abcd",
	KUBERNETES_SERVICE_HOST: "10.96.0.1",
	KUBERNETES_SERVICE_PORT_HTTPS: "443",
	T4_CLUSTER_HOST_NAME: "default",
	T4_CLUSTER_IDENTITY_TOKEN_FILE: "/var/run/secrets/t4-cluster-identity/token",
	T4_CLUSTER_SERVER_SERVICE_ACCOUNT: "release-t4-cluster-server",
} as const;

describe("cluster server configuration", () => {
	it("selects the projected server identity independently from its Kubernetes watch credentials", () => {
		const config = clusterServerConfigFromEnv(BASE_ENV);
		expect(config).toMatchObject({
			identityTokenPath: "/var/run/secrets/t4-cluster-identity/token",
			serverServiceAccountName: "release-t4-cluster-server",
			kubernetesTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
			kubernetesCaPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
			kubernetesApiAudience: "https://kubernetes.default.svc",
		});
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_IDENTITY_TOKEN_FILE: "relative/token" })).toThrow("absolute");
		expect(clusterServerConfigFromEnv({ ...BASE_ENV, T4_KUBERNETES_API_AUDIENCE: "kubernetes.custom.example" }).kubernetesApiAudience).toBe("kubernetes.custom.example");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_KUBERNETES_API_AUDIENCE: "/invalid" })).toThrow("T4_KUBERNETES_API_AUDIENCE");
	});

	it("reads only a bounded regular projected identity file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-cluster-identity-"));
		try {
			const path = join(directory, "token");
			const token = `header.payload.${"s".repeat(64)}`;
			await writeFile(path, token, { mode: 0o400 });
			expect(await readClusterIdentityToken(path)).toBe(token);
			await writeFile(path, "x".repeat(16_385), { mode: 0o400 });
			await expect(readClusterIdentityToken(path)).rejects.toThrow("invalid");
			await expect(readClusterIdentityToken(directory)).rejects.toThrow("invalid");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("accepts exactly one server-side Woodpecker credential source", () => {
		const common = {
			...BASE_ENV,
			T4_WOODPECKER_BASE_URL: "https://ci.example.test",
			T4_WOODPECKER_REPOSITORIES: '{"t4-code":{"slug":"owner/t4-code"}}',
		};
		expect(clusterServerConfigFromEnv({ ...common, T4_WOODPECKER_TOKEN_FILE: "/var/run/secrets/t4-ci/token" }).woodpecker).toMatchObject({
			tokenFile: "/var/run/secrets/t4-ci/token",
		});
		expect(clusterServerConfigFromEnv({ ...common, T4_WOODPECKER_TOKEN: "secret-from-kubernetes" }).woodpecker).toMatchObject({
			token: "secret-from-kubernetes",
		});
		expect(() => clusterServerConfigFromEnv(common)).toThrow("complete");
		expect(() => clusterServerConfigFromEnv({
			...common,
			T4_WOODPECKER_TOKEN: "secret-from-kubernetes",
			T4_WOODPECKER_TOKEN_FILE: "/var/run/secrets/t4-ci/token",
		})).toThrow("exactly one");
	});

});

describe("trusted cluster gateway proxy sources", () => {
	it("accepts bounded canonical IPv4 and IPv6 networks", () => {
		const config = clusterServerConfigFromEnv({
			...BASE_ENV,
			T4_CLUSTER_TRUSTED_PROXY_ADDRESSES: "10.42.1.7,fd7a:115c:a1e0::1",
			T4_CLUSTER_TRUSTED_PROXY_CIDRS: "10.42.0.0/16,fd7a:115c:a1e0::/48",
		});
		expect(config.trustedProxyAddresses).toEqual(["10.42.1.7", "fd7a:115c:a1e0::1"]);
		expect(config.trustedProxyCidrs).toEqual(["10.42.0.0/16", "fd7a:115c:a1e0::/48"]);
	});

	it("rejects CIDRs with host bits or non-canonical notation", () => {
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "10.42.1.7/16" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "fd7a:115c:a1e0:0::/48" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "0.0.0.0/0" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "::/0" })).toThrow();
	});

	it("bounds the trusted CIDR list", () => {
		const cidrs = Array.from({ length: 65 }, (_, index) => `10.${index}.0.0/16`).join(",");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: cidrs })).toThrow();
	});
});
