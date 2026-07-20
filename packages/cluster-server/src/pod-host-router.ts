import {
	DEVICE_CAPABILITIES,
	PROTOCOL_FEATURES,
	decodeServerFrame,
	parseBounded,
	type ClientFrame,
	type HostId,
	type ServerFrame,
} from "@t4-code/host-wire";
import { canonicalInternalDeviceToken } from "./session-host-policy.ts";

export interface PodHostEndpoint {
	readonly clusterSessionId: string;
	readonly url: string;
}
export interface PodHostRoute extends PodHostEndpoint {
	readonly upstreamSessionId: string;
}
export interface PodHostConnection {
	readonly hostId?: string;
	send(frame: ClientFrame): void;
	close(code?: number, reason?: string): void;
}
export interface PodHostConnector {
	connect(endpoint: PodHostEndpoint, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection>;
}
export interface WebSocketPodHostConnectorOptions {
	readonly internalToken: string;
	readonly openTimeoutMs?: number;
	readonly webSocketFactory?: (url: string) => WebSocket;
}

export class WebSocketPodHostConnector implements PodHostConnector {
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #factory: (url: string) => WebSocket;
	constructor(options: WebSocketPodHostConnectorOptions) {
		this.#token = canonicalInternalDeviceToken(options.internalToken);
		this.#timeoutMs = options.openTimeoutMs ?? 10_000;
		this.#factory = options.webSocketFactory ?? (url => new WebSocket(url));
	}
	connect(endpoint: PodHostEndpoint, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection> {
		if (!endpoint.url.startsWith("ws://") && !endpoint.url.startsWith("wss://")) return Promise.reject(new Error("pod host URL is invalid"));
		const socket = this.#factory(endpoint.url);
		return new Promise((resolve, reject) => {
			let settled = false;
			let upstreamHostId: string | undefined;
			const timer = setTimeout(() => {
				if (!settled) { settled = true; socket.close(1013, "upstream timeout"); reject(new Error("pod host handshake timed out")); }
			}, this.#timeoutMs);
			socket.addEventListener("open", () => {
				socket.send(JSON.stringify({
					v: "omp-app/1", type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "cluster-server", version: "0.1.30", build: "cluster", platform: "linux" },
					requestedFeatures: PROTOCOL_FEATURES.filter(feature => feature !== "cluster.operator"),
					savedCursors: [],
					capabilities: { client: DEVICE_CAPABILITIES.filter(capability => capability !== "ci.trigger") },
					authentication: { deviceId: "cluster-server", deviceToken: this.#token },
				}));
			});
			socket.addEventListener("message", event => {
				try {
					const frame = decodeServerFrame(parseBounded(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)));
					if (frame.type === "welcome") {
						if (settled) throw new Error("duplicate pod host welcome");
						if (frame.authentication !== "paired") throw new Error("pod host authentication failed");
						upstreamHostId = frame.hostId;
						settled = true;
						clearTimeout(timer);
						resolve({
							get hostId() { return upstreamHostId; },
							send: value => {
								if (socket.readyState !== WebSocket.OPEN) throw new Error("pod host connection is closed");
								socket.send(JSON.stringify(value));
							},
							close: (code, reason) => socket.close(code, reason),
						});
						return;
					}
					if (!settled) throw new Error("pod host frame arrived before welcome");
					onFrame(frame);
				} catch (error) {
					if (!settled) { settled = true; clearTimeout(timer); reject(error); }
					else socket.close(1002, "invalid upstream frame");
				}
			});
			socket.addEventListener("error", () => {
				if (!settled) { settled = true; clearTimeout(timer); reject(new Error("pod host connection failed")); }
			});
			socket.addEventListener("close", () => {
				if (!settled) { settled = true; clearTimeout(timer); reject(new Error("pod host connection closed")); }
				else onClose?.();
			});
		});
	}
}

/** Only app-wire address fields are translated; opaque ids and payload values remain byte-semantically unchanged. */
export function rewriteClientAddress(
	frame: ClientFrame,
	route: PodHostRoute,
	upstreamHostId: string,
): ClientFrame {
	if (!("hostId" in frame)) return frame;
	return {
		...frame,
		hostId: upstreamHostId as HostId,
		...(frame.sessionId === undefined ? {} : { sessionId: route.upstreamSessionId }),
	} as ClientFrame;
}

function rewriteEntry(entry: Record<string, unknown>, clusterHostId: string, clusterSessionId: string): Record<string, unknown> {
	return { ...entry, hostId: clusterHostId, sessionId: clusterSessionId };
}
export function rewriteServerAddress(
	frame: ServerFrame,
	route: PodHostRoute,
	clusterHostId: string,
): ServerFrame {
	let output: Record<string, unknown> = { ...frame };
	if ("hostId" in output) output.hostId = clusterHostId;
	if ("sessionId" in output) output.sessionId = route.clusterSessionId;
	if (frame.type === "entry") output.entry = rewriteEntry(frame.entry as unknown as Record<string, unknown>, clusterHostId, route.clusterSessionId);
	if (frame.type === "snapshot") output.entries = frame.entries.map(entry => rewriteEntry(entry as unknown as Record<string, unknown>, clusterHostId, route.clusterSessionId));
	if (frame.type === "agent.transcript") output.entries = frame.entries.map(entry => rewriteEntry(entry as unknown as Record<string, unknown>, clusterHostId, route.clusterSessionId));
	if (frame.type === "session.delta" && frame.upsert) output.upsert = { ...frame.upsert, hostId: clusterHostId, sessionId: route.clusterSessionId };
	if (frame.type === "session.delta" && frame.remove) output.remove = route.clusterSessionId;
	if (frame.type === "sessions") output.sessions = frame.sessions.map(ref => ({ ...ref, hostId: clusterHostId, sessionId: route.clusterSessionId }));
	return output as unknown as ServerFrame;
}
