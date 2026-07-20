export type RuntimeCapabilitySupport = "native" | "emulated" | "unavailable";

export type RuntimeWorkspaceOwnership = "managed" | "imported-user" | "detected-external" | "repository-root";

export interface RuntimeGitIdentity {
	readonly commonDir: string;
	readonly head: string;
	readonly remote?: string;
}

/** An immutable workspace identity supplied by the workspace authority. */
export interface RuntimeWorkspaceIdentity {
	readonly instanceId: string;
	readonly cwd: string;
	readonly ownership: RuntimeWorkspaceOwnership;
	readonly git?: RuntimeGitIdentity;
}

export interface RuntimeCommand {
	readonly executable: string;
	readonly arguments: readonly string[];
	/** CLI flag that receives the workspace cwd after the static arguments. */
	readonly cwdArgument?: string;
}

export interface RuntimeAdapterManifest {
	readonly id: string;
	readonly displayName: string;
	readonly command: RuntimeCommand;
	readonly capabilities: Readonly<Record<string, RuntimeCapabilitySupport>>;
}

export type RuntimePermissionResponse =
	| { readonly outcome: "cancelled" }
	| { readonly outcome: "selected"; readonly optionId: string };

export interface RuntimeAdapterCallbacks {
	/** Raw ACP session/update notification. No provider-specific projection is applied. */
	onSessionUpdate?(update: unknown): void | Promise<void>;
	/** Raw ACP session/request_permission request. */
	onPermissionRequest?(request: unknown): RuntimePermissionResponse | Promise<RuntimePermissionResponse>;
	onStderr?(chunk: string): void | Promise<void>;
}

export interface RuntimeSessionRequest {
	readonly workspace: RuntimeWorkspaceIdentity;
	/** Existing provider session ID. Omit to create a new session. */
	readonly sessionId?: string;
	readonly callbacks?: RuntimeAdapterCallbacks;
}

export interface RuntimeSession {
	readonly adapterId: string;
	readonly sessionId: string;
	readonly workspace: RuntimeWorkspaceIdentity;
	prompt(text: string): Promise<unknown>;
	cancel(): Promise<void>;
	dispose(): Promise<void>;
}

export interface RuntimeAdapter {
	readonly manifest: RuntimeAdapterManifest;
	openSession(request: RuntimeSessionRequest): Promise<RuntimeSession>;
}

/** A seam for appserver integration; it never changes native OMP selection semantics. */
export interface RuntimeAdapterFactory {
	create(manifest: RuntimeAdapterManifest): RuntimeAdapter;
}

export interface RuntimeExecutableProbe {
	executableAvailable(executable: string): Promise<boolean> | boolean;
}

export type RuntimeAvailability =
	| { readonly state: "available" }
	| { readonly state: "unavailable"; readonly executable: string };

export class RuntimeAdapterRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeAdapterRegistryError";
	}
}

export class RuntimeUnavailableError extends Error {
	readonly executable: string;

	constructor(executable: string) {
		super(`Runtime executable is unavailable: ${executable}`);
		this.name = "RuntimeUnavailableError";
		this.executable = executable;
	}
}

const adapterId = /^[a-z][a-z0-9-]{0,63}$/;
const capabilitySupports = new Set<RuntimeCapabilitySupport>(["native", "emulated", "unavailable"]);

export function immutableRuntimeAdapterManifest(manifest: RuntimeAdapterManifest): RuntimeAdapterManifest {
	if (!adapterId.test(manifest.id))
		throw new RuntimeAdapterRegistryError(`Invalid runtime adapter ID: ${manifest.id}`);
	if (!manifest.displayName.trim())
		throw new RuntimeAdapterRegistryError("Runtime adapter display name must not be empty");
	if (!manifest.command.executable.trim())
		throw new RuntimeAdapterRegistryError("Runtime adapter executable must not be empty");
	if (manifest.command.arguments.some(argument => typeof argument !== "string"))
		throw new RuntimeAdapterRegistryError("Runtime adapter arguments must be strings");
	if (manifest.command.cwdArgument !== undefined && !manifest.command.cwdArgument.trim())
		throw new RuntimeAdapterRegistryError("Runtime adapter cwd argument must not be empty");
	for (const [capability, support] of Object.entries(manifest.capabilities)) {
		if (!capability || !capabilitySupports.has(support))
			throw new RuntimeAdapterRegistryError(`Invalid runtime adapter capability: ${capability}`);
	}
	return Object.freeze({
		id: manifest.id,
		displayName: manifest.displayName,
		command: Object.freeze({
			executable: manifest.command.executable,
			arguments: Object.freeze([...manifest.command.arguments]),
			...(manifest.command.cwdArgument === undefined ? {} : { cwdArgument: manifest.command.cwdArgument }),
		}),
		capabilities: Object.freeze({ ...manifest.capabilities }),
	});
}

export class RuntimeAdapterRegistry {
	readonly #probe: RuntimeExecutableProbe;
	readonly #adapters = new Map<string, RuntimeAdapter>();

	constructor(probe: RuntimeExecutableProbe) {
		this.#probe = probe;
	}

	register(adapter: RuntimeAdapter): void {
		const manifest = immutableRuntimeAdapterManifest(adapter.manifest);
		if (this.#adapters.has(manifest.id)) {
			throw new RuntimeAdapterRegistryError(`Duplicate runtime adapter ID: ${manifest.id}`);
		}
		this.#adapters.set(manifest.id, {
			manifest,
			openSession: request => adapter.openSession(request),
		});
	}

	get(id: string): RuntimeAdapter | undefined {
		return this.#adapters.get(id);
	}

	list(): readonly RuntimeAdapterManifest[] {
		return [...this.#adapters.values()].map(adapter => adapter.manifest);
	}

	async availability(id: string): Promise<RuntimeAvailability> {
		const adapter = this.#adapters.get(id);
		if (!adapter) {
			throw new RuntimeAdapterRegistryError(`Unknown runtime adapter ID: ${id}`);
		}
		const executable = adapter.manifest.command.executable;
		return (await this.#probe.executableAvailable(executable))
			? { state: "available" }
			: { state: "unavailable", executable };
	}

	async openSession(id: string, request: RuntimeSessionRequest): Promise<RuntimeSession> {
		const adapter = this.#adapters.get(id);
		if (!adapter) {
			throw new RuntimeAdapterRegistryError(`Unknown runtime adapter ID: ${id}`);
		}
		const availability = await this.availability(id);
		if (availability.state === "unavailable") {
			throw new RuntimeUnavailableError(availability.executable);
		}
		return adapter.openSession(request);
	}
}
