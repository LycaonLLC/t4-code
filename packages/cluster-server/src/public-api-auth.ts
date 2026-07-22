import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { readBoundedRegularFile } from "./config.ts";
import type { ApiPrincipal, PrincipalAuthenticator } from "./public-api-v1.ts";

const SCOPE = /^[a-z][a-z0-9.-]{0,127}$/u;
interface CredentialRecord {
	readonly token: string;
	readonly principal: ApiPrincipal;
}
interface PublicApiSecrets {
	readonly cursorSecret: string;
	readonly authenticator: PrincipalAuthenticator;
}

function decodeSecrets(value: string): { cursorSecret: string; credentials: readonly CredentialRecord[] } {
	let root: unknown;
	try { root = JSON.parse(value); } catch { throw new Error("public API credentials file is invalid"); }
	if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("public API credentials file is invalid");
	const object = root as Record<string, unknown>;
	if (Object.keys(object).some(key => key !== "cursorSecret" && key !== "principals") || typeof object.cursorSecret !== "string") throw new Error("public API credentials file is invalid");
	const secretBytes = new TextEncoder().encode(object.cursorSecret);
	if (secretBytes.byteLength < 32 || secretBytes.byteLength > 4096) throw new Error("public API credentials file is invalid");
	if (!Array.isArray(object.principals) || object.principals.length < 1 || object.principals.length > 128) throw new Error("public API credentials file is invalid");
	const principals = new Set<string>();
	const tokenHashes = new Set<string>();
	const credentials: CredentialRecord[] = [];
	for (const raw of object.principals) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("public API credentials file is invalid");
		const entry = raw as Record<string, unknown>;
		if (Object.keys(entry).some(key => !["token", "principal", "scopes"].includes(key)) || typeof entry.token !== "string" || typeof entry.principal !== "string" || !Array.isArray(entry.scopes)) throw new Error("public API credentials file is invalid");
		const tokenBytes = new TextEncoder().encode(entry.token);
		if (tokenBytes.byteLength < 32 || tokenBytes.byteLength > 16_384 || /\s/u.test(entry.token)) throw new Error("public API credentials file is invalid");
		if (!entry.principal || entry.principal !== entry.principal.trim() || new TextEncoder().encode(entry.principal).byteLength > 256 || /\p{Cc}/u.test(entry.principal)) throw new Error("public API credentials file is invalid");
		if (principals.has(entry.principal)) throw new Error("public API credentials file is invalid");
		principals.add(entry.principal);
		const tokenIdentity = Buffer.from(tokenBytes).toString("base64");
		if (tokenHashes.has(tokenIdentity)) throw new Error("public API credentials file is invalid");
		tokenHashes.add(tokenIdentity);
		const scopes = entry.scopes.map(scope => {
			if (typeof scope !== "string" || !SCOPE.test(scope)) throw new Error("public API credentials file is invalid");
			return scope;
		});
		if (scopes.length < 1 || scopes.length > 128 || new Set(scopes).size !== scopes.length) throw new Error("public API credentials file is invalid");
		credentials.push({ token: entry.token, principal: { id: entry.principal, scopes: new Set(scopes) } });
	}
	return { cursorSecret: object.cursorSecret, credentials };
}

class SecretFileAuthenticator implements PrincipalAuthenticator {
	readonly #path: string;
	constructor(path: string) { this.#path = path; }
	async authenticate(token: string): Promise<ApiPrincipal | undefined> {
		const presented = Buffer.from(token, "utf8");
		const { credentials } = decodeSecrets(await readBoundedRegularFile(this.#path, 65_536, "public API credentials"));
		let principal: ApiPrincipal | undefined;
		for (const credential of credentials) {
			const expected = Buffer.from(credential.token, "utf8");
			if (expected.byteLength === presented.byteLength && timingSafeEqual(expected, presented)) principal = credential.principal;
		}
		return principal;
	}
}

export async function loadPublicApiSecrets(path: string): Promise<PublicApiSecrets> {
	if (!isAbsolute(path)) throw new Error("public API credentials file path must be absolute");
	const decoded = decodeSecrets(await readBoundedRegularFile(path, 65_536, "public API credentials"));
	return { cursorSecret: decoded.cursorSecret, authenticator: new SecretFileAuthenticator(path) };
}
