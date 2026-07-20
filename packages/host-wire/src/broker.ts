import { fail } from "./errors.js";
import { controlFree, inputObject, safeSeq } from "./guards.js";

export type BrokerStatusResult =
	| { readonly state: "local"; readonly generation: number }
	| { readonly state: "connected"; readonly endpoint: string; readonly generation: number }
	| { readonly state: "missing-token"; readonly endpoint?: string; readonly generation: number }
	| { readonly state: "unreachable"; readonly endpoint: string; readonly generation: number };

const MAX_ENDPOINT_BYTES = 2048;
const MAX_GENERATION = 2_147_483_647;

function strictObject(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
	const input = inputObject(value);
	const known = new Set(allowed);
	for (const key of Object.keys(input)) if (!known.has(key)) fail("INVALID_FRAME", "unknown field", `${path}.${key}`);
	return input;
}

function endpoint(value: unknown, path: string): string {
	const text = controlFree(value, path, MAX_ENDPOINT_BYTES);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		fail("INVALID_FRAME", "endpoint must be an HTTP(S) URL", path);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		fail("INVALID_FRAME", "endpoint must be an HTTP(S) URL", path);
	if (parsed.username || parsed.password || parsed.search || parsed.hash)
		fail("INVALID_FRAME", "endpoint must not include credentials, query, or fragment", path);
	return parsed.toString();
}

function generation(value: unknown, path: string): number {
	const result = safeSeq(value, path);
	if (result > MAX_GENERATION) fail("BOUNDS", "generation exceeds limit", path);
	return result;
}

export function decodeBrokerStatusResult(value: unknown): BrokerStatusResult {
	const input = inputObject(value);
	if (typeof input.state !== "string") fail("INVALID_FRAME", "broker state is required", "result.state");
	const state = input.state;
	if (state === "local") {
		const object = strictObject(input, "result", ["state", "generation"]);
		return { state, generation: generation(object.generation, "result.generation") };
	}
	if (state === "connected" || state === "unreachable") {
		const object = strictObject(input, "result", ["state", "endpoint", "generation"]);
		return {
			state,
			endpoint: endpoint(object.endpoint, "result.endpoint"),
			generation: generation(object.generation, "result.generation"),
		};
	}
	if (state === "missing-token") {
		const object = strictObject(input, "result", ["state", "endpoint", "generation"]);
		return {
			state,
			...(object.endpoint === undefined ? {} : { endpoint: endpoint(object.endpoint, "result.endpoint") }),
			generation: generation(object.generation, "result.generation"),
		};
	}
	fail("INVALID_FRAME", "unknown broker state", "result.state");
}
