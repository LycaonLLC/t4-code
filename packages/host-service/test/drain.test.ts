import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { hostId } from "@t4-code/host-wire";
import { createAppserver, type LocalAppserver } from "../src/server.ts";
import type { AppserverAdminCallbacks } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("host-test");
const epoch = "epoch-test";
const health = { ok: true as const, hostId: host, epoch };
const idleBusy = {
	connections: 0,
	inflightMessages: 0,
	startingSupervisors: 0,
	lifecycleMutations: 0,
	sessionOperations: 0,
	activePrompts: 0,
	rpcSupervisorsWithPendingCalls: 0,
	busySessions: 0,
	openTerminalSessions: 0,
	pendingConfirmations: 0,
	outboundSends: 0,
};

interface AdminResponse {
	status: number;
	body: unknown;
}

const started: LocalAppserver[] = [];
const roots: string[] = [];

afterEach(async () => {
	await Promise.allSettled(started.splice(0).map(appserver => appserver.stop()));
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function startAppserver(socketPath?: string, admin?: AppserverAdminCallbacks): Promise<LocalAppserver> {
	const root = socketPath ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "omp-appserver-drain-"));
	if (root) roots.push(root);
	const appserver = createAppserver({
		hostId: host,
		epoch,
		socketPath: socketPath ?? path.join(root!, "appserver.sock"),
		admin,
	});
	await appserver.start();
	started.push(appserver);
	return appserver;
}

function adminRequest(socketPath: string, path: string, payload: string, partial = false) {
	const gate = Promise.withResolvers<AdminResponse>();
	const request = http.request(
		{
			socketPath,
			path,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload),
			},
		},
		response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(Buffer.from(chunk)));
			response.once("error", gate.reject);
			response.once("end", () => {
				try {
					gate.resolve({
						status: response.statusCode ?? 0,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
					});
				} catch (error) {
					gate.reject(error);
				}
			});
		},
	);
	request.once("error", gate.reject);
	if (partial) request.write(payload.slice(0, -1));
	else request.end(payload);
	return { request, response: gate.promise };
}

async function postDrain(
	socketPath: string,
	body: { expectedHostId: string; expectedEpoch: string },
): Promise<AdminResponse> {
	const payload = JSON.stringify(body);
	return adminRequest(socketPath, "/admin/drain-if-idle", payload).response;
}

describe("atomic appserver drain", () => {
	test("identity mismatch reports the complete idle snapshot and leaves websocket ingress usable", async () => {
		const appserver = await startAppserver();
		const response = await postDrain(appserver.socketPath, {
			expectedHostId: "another-host",
			expectedEpoch: epoch,
		});

		expect(response).toEqual({
			status: 200,
			body: { state: "identity_mismatch", health, busy: idleBusy },
		});
		const client = await RawUdsWebSocket.connect(appserver.socketPath);
		await client.close();
	});

	test("an open connection reports busy without fencing existing or new clients", async () => {
		const appserver = await startAppserver();
		const first = await RawUdsWebSocket.connect(appserver.socketPath);
		const response = await postDrain(appserver.socketPath, {
			expectedHostId: host,
			expectedEpoch: epoch,
		});

		expect(response).toEqual({
			status: 200,
			body: {
				state: "busy",
				health,
				busy: { ...idleBusy, connections: 1 },
			},
		});
		const second = await RawUdsWebSocket.connect(appserver.socketPath);
		await Promise.all([first.close(), second.close()]);
	});

	test("an idle drain atomically fences new websocket command ingress until restart", async () => {
		const appserver = await startAppserver();
		const socketPath = appserver.socketPath;
		const response = await postDrain(socketPath, {
			expectedHostId: host,
			expectedEpoch: epoch,
		});

		expect(response).toEqual({
			status: 200,
			body: { state: "draining", health, busy: idleBusy },
		});
		await expect(RawUdsWebSocket.connect(socketPath)).rejects.toThrow("websocket handshake failed");

		await appserver.stop();
		started.splice(started.indexOf(appserver), 1);
		const restarted = await startAppserver(socketPath);
		const client = await RawUdsWebSocket.connect(restarted.socketPath);
		await client.close();
	});

	test("an in-flight owner mutation blocks drain and new mutations stay fenced after success", async () => {
		const revoked: string[] = [];
		const appserver = await startAppserver(undefined, {
			issuePairingTicket: () => ({ code: "123456", expiresAt: Date.now() + 60_000 }),
			listDevices: () => [],
			revokeDevice: deviceId => {
				revoked.push(deviceId);
				return { revoked: true };
			},
		});
		const blocker = await RawUdsWebSocket.connect(appserver.socketPath);
		const payload = JSON.stringify({ deviceId: "device-before-drain" });
		const pending = adminRequest(appserver.socketPath, "/admin/revoke", payload, true);

		let concurrent: AdminResponse | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await postDrain(appserver.socketPath, { expectedHostId: host, expectedEpoch: epoch });
			if (
				JSON.stringify(response.body) ===
				JSON.stringify({
					state: "busy",
					health,
					busy: { ...idleBusy, connections: 1, lifecycleMutations: 1 },
				})
			) {
				concurrent = response;
				break;
			}
			await Bun.sleep(5);
		}
		expect(concurrent).toEqual({
			status: 200,
			body: {
				state: "busy",
				health,
				busy: { ...idleBusy, connections: 1, lifecycleMutations: 1 },
			},
		});

		await blocker.close();
		let mutationOnly: AdminResponse | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await postDrain(appserver.socketPath, { expectedHostId: host, expectedEpoch: epoch });
			if (
				JSON.stringify(response.body) ===
				JSON.stringify({
					state: "busy",
					health,
					busy: { ...idleBusy, lifecycleMutations: 1 },
				})
			) {
				mutationOnly = response;
				break;
			}
			await Bun.sleep(5);
		}
		expect(mutationOnly).toEqual({
			status: 200,
			body: {
				state: "busy",
				health,
				busy: { ...idleBusy, lifecycleMutations: 1 },
			},
		});

		pending.request.end(payload.slice(-1));
		expect(await pending.response).toEqual({ status: 200, body: { revoked: true } });
		expect(revoked).toEqual(["device-before-drain"]);
		expect(await postDrain(appserver.socketPath, { expectedHostId: host, expectedEpoch: epoch })).toEqual({
			status: 200,
			body: { state: "draining", health, busy: idleBusy },
		});

		const rejected = adminRequest(
			appserver.socketPath,
			"/admin/revoke",
			JSON.stringify({ deviceId: "device-after-drain" }),
		);
		expect(await rejected.response).toEqual({
			status: 503,
			body: { error: "invalid admin request" },
		});
		expect(revoked).toEqual(["device-before-drain"]);
	});
});
