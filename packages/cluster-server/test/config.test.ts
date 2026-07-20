import { describe, expect, test } from "bun:test";
import { clusterServerConfigFromEnv } from "../src/config.ts";

const BASE_ENV = {
	POD_NAMESPACE: "cluster-system",
	POD_NAME: "cluster-server-0",
	POD_UID: "12345678-abcd",
	KUBERNETES_SERVICE_HOST: "10.96.0.1",
	KUBERNETES_SERVICE_PORT_HTTPS: "443",
	T4_CLUSTER_HOST_NAME: "default",
	T4_CLUSTER_INTERNAL_TOKEN: "x".repeat(32),
} as const;

describe("trusted cluster gateway proxy sources", () => {
	test("accepts bounded canonical IPv4 and IPv6 networks", () => {
		const config = clusterServerConfigFromEnv({
			...BASE_ENV,
			T4_CLUSTER_TRUSTED_PROXY_ADDRESSES: "10.42.1.7,fd7a:115c:a1e0::1",
			T4_CLUSTER_TRUSTED_PROXY_CIDRS: "10.42.0.0/16,fd7a:115c:a1e0::/48",
		});
		expect(config.trustedProxyAddresses).toEqual(["10.42.1.7", "fd7a:115c:a1e0::1"]);
		expect(config.trustedProxyCidrs).toEqual(["10.42.0.0/16", "fd7a:115c:a1e0::/48"]);
	});

	test("rejects CIDRs with host bits or non-canonical notation", () => {
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "10.42.1.7/16" })).toThrow();
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: "fd7a:115c:a1e0:0::/48" })).toThrow();
	});

	test("bounds the trusted CIDR list", () => {
		const cidrs = Array.from({ length: 65 }, (_, index) => `10.${index}.0.0/16`).join(",");
		expect(() => clusterServerConfigFromEnv({ ...BASE_ENV, T4_CLUSTER_TRUSTED_PROXY_CIDRS: cidrs })).toThrow();
	});
});
