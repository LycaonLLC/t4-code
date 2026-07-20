import { AcpRuntimeAdapter, type AcpRuntimeAdapterOptions, bunAcpProcessRunner } from "./acp-runtime-adapter.ts";
import { type RuntimeAdapterManifest, RuntimeAdapterRegistry } from "./runtime-adapter.ts";

export const ACP_RUNTIME_PRESETS = [
	{
		id: "codex",
		displayName: "Codex",
		command: { executable: "codex-acp", arguments: [] },
		capabilities: {
			"session-create": "native",
			"session-load": "native",
			prompt: "native",
			cancel: "native",
			"session-updates": "native",
			permissions: "native",
			elicitation: "unavailable",
			"workspace-mutation": "unavailable",
		},
	},
	{
		id: "claude",
		displayName: "Claude",
		command: { executable: "claude-agent-acp", arguments: [] },
		capabilities: {
			"session-create": "native",
			"session-load": "native",
			prompt: "native",
			cancel: "native",
			"session-updates": "native",
			permissions: "native",
			elicitation: "unavailable",
			"workspace-mutation": "unavailable",
		},
	},
	{
		id: "opencode",
		displayName: "OpenCode",
		command: { executable: "opencode", arguments: ["acp"], cwdArgument: "--cwd" },
		capabilities: {
			"session-create": "native",
			"session-load": "native",
			prompt: "native",
			cancel: "native",
			"session-updates": "native",
			permissions: "native",
			elicitation: "unavailable",
			"workspace-mutation": "unavailable",
		},
	},
] as const satisfies readonly RuntimeAdapterManifest[];

/** Creates only external ACP adapters; native OMP remains the caller's default runtime. */
export function createAcpRuntimePresetRegistry(options: AcpRuntimeAdapterOptions = {}): RuntimeAdapterRegistry {
	const runner = options.runner ?? bunAcpProcessRunner;
	const registry = new RuntimeAdapterRegistry(runner);
	for (const manifest of ACP_RUNTIME_PRESETS) registry.register(new AcpRuntimeAdapter(manifest, options));
	return registry;
}
