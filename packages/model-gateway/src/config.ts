import { readFile } from "node:fs/promises";
import path from "node:path";

export const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "api-key"] as const;
export type CredentialHeader = (typeof CREDENTIAL_HEADERS)[number];

export interface ModelGatewayConfig {
	readonly upstreamOrigin: URL;
	readonly credentialHeader: CredentialHeader;
	readonly credentialFile: string;
	readonly allowedPaths: readonly string[];
	readonly port: number;
	readonly adminPort: number;
	readonly timeoutMs: number;
	readonly maxRequestBodyBytes: number;
}

export function parseAllowedPaths(raw: string): readonly string[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("T4_MODEL_GATEWAY_ALLOWED_PATHS must be a JSON array");
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
		throw new Error("T4_MODEL_GATEWAY_ALLOWED_PATHS must contain between 1 and 32 paths");
	}
	const paths = value.map(item => {
		if (
			typeof item !== "string" ||
			item.length === 0 ||
			item.length > 256 ||
			!item.startsWith("/") ||
			item.startsWith("//") ||
			item.includes("\\") ||
			item.includes("?") ||
			item.includes("#") ||
			new URL(item, "https://path.invalid").pathname !== item
		) {
			throw new Error("T4_MODEL_GATEWAY_ALLOWED_PATHS contains an invalid exact path");
		}
		return item;
	});
	if (new Set(paths).size !== paths.length) throw new Error("T4_MODEL_GATEWAY_ALLOWED_PATHS contains duplicates");
	return Object.freeze(paths);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

export function parseUpstreamOrigin(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("T4_MODEL_GATEWAY_UPSTREAM_ORIGIN must be a valid HTTPS origin");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("T4_MODEL_GATEWAY_UPSTREAM_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment");
	}
	return url;
}

export async function readCredential(filePath: string): Promise<string> {
	if (!path.isAbsolute(filePath)) throw new Error("T4_MODEL_GATEWAY_CREDENTIAL_FILE must be absolute");
	const bytes = await readFile(filePath);
	if (bytes.byteLength === 0 || bytes.byteLength > 16_384) throw new Error("model gateway credential length is invalid");
	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("model gateway credential is not valid UTF-8");
	}
	if (value.endsWith("\n")) value = value.slice(0, -1);
	if (value.endsWith("\r")) value = value.slice(0, -1);
	if (value.length === 0 || value.trim() !== value || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/u.test(value)) {
		throw new Error("model gateway credential contains an invalid character");
	}
	return value;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ModelGatewayConfig> {
	const credentialHeader = required(env, "T4_MODEL_GATEWAY_CREDENTIAL_HEADER").toLowerCase();
	if (!CREDENTIAL_HEADERS.includes(credentialHeader as CredentialHeader)) {
		throw new Error(`T4_MODEL_GATEWAY_CREDENTIAL_HEADER must be one of ${CREDENTIAL_HEADERS.join(", ")}`);
	}
	const credentialFile = required(env, "T4_MODEL_GATEWAY_CREDENTIAL_FILE");
	await readCredential(credentialFile);
	const port = integer(env, "T4_MODEL_GATEWAY_PORT", 8080, 1, 65_535);
	const adminPort = integer(env, "T4_MODEL_GATEWAY_ADMIN_PORT", 9090, 1, 65_535);
	if (port === adminPort) throw new Error("model gateway and admin ports must be different");
	return {
		upstreamOrigin: parseUpstreamOrigin(required(env, "T4_MODEL_GATEWAY_UPSTREAM_ORIGIN")),
		credentialHeader: credentialHeader as CredentialHeader,
		credentialFile,
		allowedPaths: parseAllowedPaths(required(env, "T4_MODEL_GATEWAY_ALLOWED_PATHS")),
		port,
		adminPort,
		timeoutMs: integer(env, "T4_MODEL_GATEWAY_TIMEOUT_MS", 600_000, 1_000, 900_000),
		maxRequestBodyBytes: integer(env, "T4_MODEL_GATEWAY_MAX_REQUEST_BODY_BYTES", 16_777_216, 1_024, 67_108_864),
	};
}
