import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, type ServerFrame, sessionId } from "@t4-code/host-wire";
import { type RuntimeAdapter, type RuntimeAdapterCallbacks, RuntimeAdapterRegistry } from "../src/runtime-adapter.ts";
import { appserverSupportedFeatures, createAppserver } from "../src/server.ts";
import { WorkspaceAuthority } from "../src/workspace-authority.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("runtime-workspace-test-host");

async function git(cwd: string, ...arguments_: string[]): Promise<void> {
	const child = Bun.spawn(["git", "-C", cwd, ...arguments_], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
}

function hello(): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "authority-test", version: "1", build: "test", platform: "linux" },
		requestedFeatures: ["runtime.adapters", "workspace.lifecycle"],
		capabilities: { client: ["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control"] },
		savedCursors: [],
	};
}

function command(requestId: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId,
		commandId: requestId,
		hostId: host,
		command: name,
		args,
	};
}

async function response(
	client: RawUdsWebSocket,
	requestId: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "response" && frame.requestId === requestId) return frame;
	}
}

async function sessionEvent(client: RawUdsWebSocket, type: string): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "event" && frame.event.type === type) return frame.event;
	}
}

async function approveChallenge(
	client: RawUdsWebSocket,
	requestId: string,
	sessionId: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type !== "confirmation" || frame.commandId !== requestId) continue;
		client.sendJson({
			v: "omp-app/1",
			type: "confirm",
			requestId: `${requestId}-confirm`,
			confirmationId: frame.confirmationId,
			commandId: requestId,
			hostId: host,
			sessionId,
			decision: "approve",
		});
		return response(client, requestId);
	}
}

test("negotiates and serves runtime and workspace authority commands", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-authority-wire-")));
	const workspaceAuthority = await WorkspaceAuthority.open({ databasePath: join(root, "workspaces.sqlite") });
	const repository = join(root, "repository");
	await mkdir(repository);
	await git(repository, "init", "-q");
	await git(repository, "config", "user.email", "test@example.invalid");
	await git(repository, "config", "user.name", "Runtime Workspace Test");
	await writeFile(join(repository, "README.md"), "fixture\n");
	await git(repository, "add", "README.md");
	await git(repository, "commit", "-qm", "fixture");
	await workspaceAuthority.import({
		repositoryId: "project-wire",
		repositoryPath: repository,
		workspacePath: repository,
		ownership: "repository-root",
	});
	const runtimes = new RuntimeAdapterRegistry({
		executableAvailable: executable => {
			if (executable === "broken-runtime") throw new Error("probe failed");
			return true;
		},
	});
	const adapter: RuntimeAdapter = {
		manifest: {
			id: "test-runtime",
			displayName: "Test Runtime",
			command: { executable: "test-runtime", arguments: [] },
			capabilities: { prompt: "native" },
		},
		openSession: async () => {
			throw new Error("not used by discovery commands");
		},
	};
	runtimes.register(adapter);
	runtimes.register({
		...adapter,
		manifest: { ...adapter.manifest, id: "broken-runtime", command: { executable: "broken-runtime", arguments: [] } },
	});
	expect(appserverSupportedFeatures({ workspaceAuthority })).not.toContain("workspace.lifecycle");
	const appserver = createAppserver({
		hostId: host,
		epoch: "authority-wire-test",
		socketPath: join(root, "run", "app.sock"),
		runtimeAdapters: runtimes,
		workspaceAuthority,
		projectRootForProject: () => repository,
		workspaceTargetPathForProject: (_projectId, name) => join(root, name),
	});
	let client: RawUdsWebSocket | undefined;
	try {
		await appserver.start();
		client = await RawUdsWebSocket.connect(appserver.socketPath);
		client.sendJson(hello());
		const welcome = await client.nextServer();
		expect(welcome).toMatchObject({
			type: "welcome",
			grantedFeatures: expect.arrayContaining(["runtime.adapters", "workspace.lifecycle"]),
		});
		expect((await client.nextServer()).type).toBe("sessions");

		client.sendJson(command("runtime-list", "runtime.list"));
		expect(await response(client, "runtime-list")).toMatchObject({
			ok: true,
			result: {
				runtimes: [
					{
						id: "test-runtime",
						availability: { state: "available" },
					},
					{
						id: "broken-runtime",
						availability: { state: "unknown" },
					},
				],
			},
		});

		client.sendJson(command("workspace-list", "workspace.list"));
		const workspaceList = await response(client, "workspace-list");
		expect(workspaceList).toMatchObject({
			ok: true,
			result: { workspaces: [{ repositoryId: "project-wire", ownership: "repository-root" }] },
		});
		const projectedWorkspace = (workspaceList.result as { workspaces: Array<Record<string, unknown>> })
			.workspaces[0]!;
		expect(projectedWorkspace).not.toHaveProperty("repositoryRoot");
		expect(projectedWorkspace).not.toHaveProperty("canonicalPath");
		expect(projectedWorkspace).not.toHaveProperty("recoveryDiagnostic");

		client.sendJson(command("workspace-recover", "workspace.recover"));
		expect(await response(client, "workspace-recover")).toMatchObject({ ok: true, result: { workspaces: [] } });
	} finally {
		client?.destroy();
		if (client) await client.closed();
		await appserver.stop();
		workspaceAuthority.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("runs owner initialization only after exclusive appserver ownership", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-owner-initialization-")));
	const socketPath = join(root, "run", "app.sock");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let competingHookRan = false;
	const owner = createAppserver({
		hostId: host,
		epoch: "owner-initialization-test",
		socketPath,
		onOwnerAcquired: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	const competing = createAppserver({
		hostId: host,
		epoch: "competing-owner-test",
		socketPath,
		onOwnerAcquired: () => {
			competingHookRan = true;
		},
	});
	try {
		const ownerStart = owner.start();
		await entered.promise;
		await expect(competing.start()).rejects.toThrow("another owner");
		expect(competingHookRan).toBeFalse();
		release.resolve();
		await ownerStart;
	} finally {
		release.resolve();
		await competing.stop();
		await owner.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("routes an external runtime session through appserver-owned workspace identity", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omp-external-runtime-wire-")));
	const workspaceAuthority = await WorkspaceAuthority.open({ databasePath: join(root, "workspaces.sqlite") });
	const repository = join(root, "repository");
	await mkdir(repository);
	await git(repository, "init", "-q");
	await git(repository, "config", "user.email", "test@example.invalid");
	await git(repository, "config", "user.name", "Runtime Ownership Test");
	await writeFile(join(repository, "README.md"), "fixture\n");
	await git(repository, "add", "README.md");
	await git(repository, "commit", "-qm", "fixture");
	const workspace = await workspaceAuthority.import({
		repositoryId: "project-external",
		repositoryPath: repository,
		workspacePath: repository,
		ownership: "repository-root",
	});
	const promptEntered = Promise.withResolvers<void>();
	const promptRelease = Promise.withResolvers<void>();
	const permissionEntered = Promise.withResolvers<void>();
	let permissionSelection: unknown;
	let promptCount = 0;
	let callbacks: RuntimeAdapterCallbacks | undefined;
	let openedCwd: string | undefined;
	let prompted: string | undefined;
	let cancelled = 0;
	let disposed = 0;
	const runtimes = new RuntimeAdapterRegistry({ executableAvailable: () => true });
	runtimes.register({
		manifest: {
			id: "test-runtime",
			displayName: "Test Runtime",
			command: { executable: "test-runtime", arguments: [] },
			capabilities: { prompt: "native", cancel: "native" },
		},
		async openSession(request) {
			callbacks = request.callbacks;
			openedCwd = request.workspace.cwd;
			return {
				adapterId: "test-runtime",
				sessionId: "provider-private-session",
				workspace: request.workspace,
				async prompt(text) {
					promptCount += 1;
					prompted = text;
					if (promptCount === 1) {
						promptEntered.resolve();
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: "external response" },
							},
						});
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: " complete" },
							},
						});
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "tool_call",
								toolCallId: "provider-tool-id",
								title: "Run command",
								kind: "execute",
							},
						});
						await callbacks?.onSessionUpdate?.({
							sessionId: "provider-private-session",
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: "provider-tool-id",
								status: "completed",
							},
						});
						await promptRelease.promise;
					} else {
						permissionEntered.resolve();
						permissionSelection = await callbacks?.onPermissionRequest?.({
							sessionId: "provider-private-session",
							toolCall: { toolCallId: "provider-tool-id", title: "Run command" },
							options: [
								{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
								{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
							],
						});
					}
					return { stopReason: "end_turn" };
				},
				async cancel() {
					cancelled += 1;
				},
				async dispose() {
					disposed += 1;
				},
			};
		},
	});
	const appserver = createAppserver({
		hostId: host,
		epoch: "external-runtime-test",
		socketPath: join(root, "run", "app.sock"),
		runtimeAdapters: runtimes,
		workspaceAuthority,
		projectRootForProject: () => repository,
		workspaceTargetPathForProject: (_projectId, name) => join(root, name),
	});
	let client: RawUdsWebSocket | undefined;
	try {
		await appserver.start();
		client = await RawUdsWebSocket.connect(appserver.socketPath);
		client.sendJson(hello());
		expect((await client.nextServer()).type).toBe("welcome");
		expect((await client.nextServer()).type).toBe("sessions");

		client.sendJson(
			command("create-external", "session.create", {
				projectId: "project-external",
				runtimeId: "test-runtime",
				workspaceInstanceId: workspace.instanceId,
				title: "External session",
			}),
		);
		const created = await response(client, "create-external");
		expect(created).toMatchObject({
			ok: true,
			result: {
				session: {
					project: { projectId: "project-external" },
					runtime: { id: "test-runtime", workspaceInstanceId: workspace.instanceId },
				},
			},
		});
		expect(JSON.stringify(created)).not.toContain(repository);
		expect(JSON.stringify(created)).not.toContain("provider-private-session");
		expect(openedCwd).toBe(repository);
		const publicSessionId = (created.result as { session: { sessionId: string } }).session.sessionId;
		const sessionCommand = (requestId: string, name: string, args: Record<string, unknown> = {}) => ({
			...command(requestId, name, args),
			sessionId: publicSessionId,
		});

		client.sendJson(sessionCommand("state-external", "session.state.get"));
		expect(await response(client, "state-external")).toMatchObject({ ok: false, error: { code: "unsupported" } });
		client.sendJson(sessionCommand("attach-external", "session.attach"));
		expect(await response(client, "attach-external")).toMatchObject({ ok: true, result: { attached: true } });

		client.sendJson(sessionCommand("prompt-external", "session.prompt", { message: "run externally" }));
		await promptEntered.promise;
		expect(prompted).toBe("run externally");
		expect(await sessionEvent(client, "tool.result")).toMatchObject({ ok: true, result: { status: "completed" } });
		client.sendJson(sessionCommand("cancel-external", "session.cancel"));
		expect(await approveChallenge(client, "cancel-external", publicSessionId)).toMatchObject({
			ok: true,
			result: { cancelled: true },
		});
		expect(cancelled).toBe(1);
		client.sendJson(sessionCommand("prompt-before-cancel-settles", "session.prompt", { message: "too soon" }));
		expect(await response(client, "prompt-before-cancel-settles")).toMatchObject({
			ok: false,
			error: { code: "session_busy" },
		});
		promptRelease.resolve();
		expect(await response(client, "prompt-external")).toMatchObject({ ok: true, result: { accepted: true } });

		client.sendJson(sessionCommand("prompt-permission", "session.prompt", { message: "ask permission" }));
		await permissionEntered.promise;
		const pendingSnapshot = appserver.snapshot(sessionId(publicSessionId));
		const permissionId = pendingSnapshot?.ref.attention?.pending[0]?.id;
		expect(permissionId?.startsWith("acp-permission-")).toBeTrue();
		expect(JSON.stringify(pendingSnapshot?.ref.attention)).not.toContain("provider-tool-id");
		client.sendJson(
			sessionCommand("approve-permission", "session.ui.respond", { requestId: permissionId, confirmed: true }),
		);
		expect(await response(client, "approve-permission")).toMatchObject({ ok: true, result: { accepted: true } });
		expect(await response(client, "prompt-permission")).toMatchObject({ ok: true, result: { accepted: true } });
		expect(permissionSelection).toEqual({ outcome: "selected", optionId: "allow-once" });

		const snapshot = appserver.snapshot(sessionId(publicSessionId));
		expect(JSON.stringify(snapshot)).not.toContain("provider-private-session");
		expect(JSON.stringify(snapshot)).not.toContain("provider-tool-id");
		expect(snapshot?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "message", data: { role: "user", text: "run externally" } }),
				expect.objectContaining({
					kind: "message",
					data: { role: "assistant", text: "external response complete" },
				}),
			]),
		);
		const toolEntries = snapshot?.entries.filter(entry => entry.kind === "tool-use") ?? [];
		expect(toolEntries).toHaveLength(1);
		expect(toolEntries[0]?.data).toMatchObject({ tool: "execute", title: "Run command", status: "completed" });
		expect(toolEntries[0]?.data.toolCallId).not.toBe("provider-tool-id");

		client.sendJson({
			...sessionCommand("close-external", "session.close"),
			expectedRevision: snapshot!.revision,
		});
		expect(await approveChallenge(client, "close-external", publicSessionId)).toMatchObject({
			ok: true,
			result: { closed: true },
		});
		expect(disposed).toBe(1);
	} finally {
		promptRelease.resolve();
		client?.destroy();
		if (client) await client.closed();
		await appserver.stop();
		workspaceAuthority.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
