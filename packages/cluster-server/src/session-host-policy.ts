import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import {
	requiredCapability,
	type ClientFrame,
	type HelloFrame,
} from "@t4-code/host-wire";
import type {
	RemoteAuthorizationContext,
	RemoteConnectionPolicy,
	RemoteHelloDecision,
} from "@t4-code/host-service";
import type { RemoteConnection } from "@t4-code/host-service";

const SESSION_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
interface ConnectionGrant { capabilities: Set<string>; features: Set<string>; }
export interface ClusterInternalRemotePolicyOptions {
	readonly token: string;
	readonly supportedCapabilities: readonly string[];
	readonly supportedFeatures: readonly string[];
}

/** Converts the mounted secret to the canonical 32-byte base64url token used by omp-app/1. */
export function canonicalInternalDeviceToken(secret: string): string {
	if (new TextEncoder().encode(secret).byteLength < 32 || secret.length > 16_384) throw new Error("cluster internal token is invalid");
	return createHash("sha256").update(secret, "utf8").digest("base64url");
}
function sameToken(expectedSecret: string, supplied: string): boolean {
	try {
		const expected = Buffer.from(canonicalInternalDeviceToken(expectedSecret));
		const canonical = /^[A-Za-z0-9_-]{43}$/u.test(supplied) ? supplied : canonicalInternalDeviceToken(supplied);
		const actual = Buffer.from(canonical);
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	} catch { return false; }
}

export class ClusterInternalRemotePolicy implements RemoteConnectionPolicy {
	readonly #token: string;
	readonly #capabilities: readonly string[];
	readonly #features: readonly string[];
	readonly #connections = new Map<string, ConnectionGrant>();
	constructor(options: ClusterInternalRemotePolicyOptions) {
		canonicalInternalDeviceToken(options.token);
		this.#token = options.token;
		this.#capabilities = [...new Set(options.supportedCapabilities)].filter(value => value !== "ci.trigger");
		this.#features = [...new Set(options.supportedFeatures)].filter(value => value !== "cluster.operator");
	}
	async authenticate(connection: RemoteConnection, hello: HelloFrame): Promise<RemoteHelloDecision> {
		const authentication = hello.authentication;
		if (connection.peer.identity.nodeId !== "cluster-server" || authentication?.deviceId !== "cluster-server" || !sameToken(this.#token, authentication.deviceToken)) {
			this.#connections.delete(connection.connectionId);
			return { authenticated: false, authentication: "denied", grantedCapabilities: [], grantedFeatures: [] };
		}
		const requestedCapabilities = new Set(hello.capabilities?.client ?? this.#capabilities);
		const requestedFeatures = new Set(hello.requestedFeatures);
		const grantedCapabilities = this.#capabilities.filter(value => requestedCapabilities.has(value));
		const grantedFeatures = this.#features.filter(value => requestedFeatures.has(value));
		this.#connections.set(connection.connectionId, { capabilities: new Set(grantedCapabilities), features: new Set(grantedFeatures) });
		return { authenticated: true, authentication: "paired", deviceId: "cluster-server", grantedCapabilities, grantedFeatures };
	}
	authorize(connection: RemoteConnection, frame: ClientFrame, _context: RemoteAuthorizationContext): boolean {
		const grant = this.#connections.get(connection.connectionId);
		if (!grant) return false;
		if (frame.type === "confirm") return true;
		if (frame.type === "ping") return true;
		if (frame.type === "terminal.input") return grant.features.has("terminal.io") && grant.capabilities.has("term.input");
		if (frame.type === "terminal.resize") return grant.features.has("terminal.io") && grant.capabilities.has("term.resize");
		if (frame.type === "terminal.close") return grant.features.has("terminal.io") && grant.capabilities.has("term.open");
		if (frame.type !== "command") return false;
		const capability = requiredCapability(frame.command);
		return capability !== undefined && grant.capabilities.has(capability);
	}
	disconnected(connection: RemoteConnection): void { this.#connections.delete(connection.connectionId); }
}

export interface SessionHostConfig {
	readonly internalToken: string;
	readonly sessionName: string;
	readonly ompExecutable: string;
	readonly stateRoot: string;
	readonly port: number;
}
export function sessionHostConfigFromEnv(env: Readonly<Record<string, string | undefined>>): SessionHostConfig {
	const internalToken = env.T4_CLUSTER_INTERNAL_TOKEN ?? "";
	canonicalInternalDeviceToken(internalToken);
	const sessionName = env.T4_SESSION_NAME ?? "";
	if (!SESSION_NAME.test(sessionName)) throw new Error("T4_SESSION_NAME is invalid");
	const ompExecutable = env.T4_OMP_EXECUTABLE ?? "/opt/t4/bin/omp";
	if (!isAbsolute(ompExecutable)) throw new Error("T4_OMP_EXECUTABLE must be absolute");
	const stateRoot = env.T4_SESSION_STATE_ROOT ?? `/workspace/.t4/sessions/${sessionName}`;
	if (stateRoot !== `/workspace/.t4/sessions/${sessionName}`) throw new Error("T4_SESSION_STATE_ROOT must select the isolated session directory");
	const port = Number(env.T4_SESSION_HOST_PORT ?? "8787");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("T4_SESSION_HOST_PORT is invalid");
	return { internalToken, sessionName, ompExecutable, stateRoot, port };
}
