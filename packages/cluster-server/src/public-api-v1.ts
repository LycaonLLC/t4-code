import { randomUUID } from "node:crypto";
import type { components } from "../../t4-api-client/src/generated/schema.ts";
import {
	canonicalRequestFingerprint,
	type LedgerMutationResult,
	type PostgresLedger,
} from "./ledger.ts";

type Discovery = components["schemas"]["Discovery"];
type ErrorCode = components["schemas"]["ApiError"]["code"];
type CommandCreate = components["schemas"]["CommandCreate"];
type WorkspaceCreate = components["schemas"]["WorkspaceCreate"];
type WorkspaceMutation = components["schemas"]["WorkspaceMutation"];
type SessionCreate = components["schemas"]["SessionCreate"];
type SessionMutation = components["schemas"]["SessionMutation"];

export interface ApiPrincipal {
	readonly id: string;
	readonly scopes: ReadonlySet<string>;
}
export interface PrincipalAuthenticator {
	authenticate(token: string): Promise<ApiPrincipal | undefined>;
}
export interface T4PublicApiV1Options {
	readonly ledger: PostgresLedger;
	readonly authenticator: PrincipalAuthenticator;
	readonly allowedOrigins?: readonly string[] | (() => readonly string[]);
}

const CAPABILITY_REQUIRED_SCOPES = [
	["workspace.lifecycle", ["workspaces.read", "workspaces.write"]],
	["session.lifecycle", ["sessions.read", "sessions.write"]],
	["session.commands", ["commands.write"]],
	["session.watch.sse", ["events.read"]],
] as const;
const DISCOVERY: Omit<Discovery, "capabilities"> = {
	apiVersion: "1.0",
	serverBuild: { version: "0.1.30", revision: "cluster" },
	supportedMajors: [1],
	limits: {
		pageSizeDefault: 25,
		pageSizeMax: 100,
		commandBytesMax: 262_144,
		commandRequestBytesMax: 1_048_576,
		commandMetadataValueBytesMax: 262_144,
		watchEventsMax: 1_000,
		heartbeatSeconds: 15,
	},
};
function discoveryFor(principal: ApiPrincipal): Discovery {
	const capabilities: Discovery["capabilities"] = {};
	for (const [capability, requiredScopes] of CAPABILITY_REQUIRED_SCOPES) {
		capabilities[capability] = {
			supported: true,
			enabled: true,
			authorized: requiredScopes.every(scope => principal.scopes.has(scope)),
			available: true,
		};
	}
	return { ...DISCOVERY, capabilities };
}
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/u;
const VERSION = /^[1-9][0-9]{0,3}(?:\.[0-9]+)?$/u;
const LABEL_KEY = /^[a-z][a-z0-9.-]{0,62}$/u;
const CRD_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const encoder = new TextEncoder();

interface ApiContext { readonly requestId: string; readonly principal: ApiPrincipal; }
interface ParsedObject { readonly value?: Record<string, unknown>; readonly response?: Response; }

function responseHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({ "cache-control": "no-store", "t4-api-version": "1.0", ...extra });
}
function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
	const headers = responseHeaders({ "content-type": "application/json", ...extra });
	return new Response(JSON.stringify(body), { status, headers });
}
function apiError(requestId: string, status: number, code: ErrorCode, message: string, details: Record<string, unknown> = {}): Response {
	return jsonResponse(status, { error: { code, message, requestId, retryable: status === 503, ...details } });
}
function notFound(requestId: string): Response { return apiError(requestId, 404, "not_found", "resource was not found"); }
function resultResponse<T>(result: LedgerMutationResult<T>, requestId: string, acceptedStatus: number): Response {
	if (result.kind === "idempotency_conflict") return apiError(requestId, 409, "idempotency_conflict", "idempotency key was reused with another canonical request");
	if (result.kind === "revision_conflict") return apiError(requestId, 409, "revision_conflict", "resource revision does not match If-Match");
	if (result.kind === "not_found") return notFound(requestId);
	const replayed = result.kind === "replay";
	const status = replayed ? 200 : acceptedStatus;
	return jsonResponse(status, result.value, { "idempotency-replayed": replayed ? "true" : "false" });
}
function deletedResponse(result: LedgerMutationResult<unknown>, requestId: string): Response {
	if (result.kind === "idempotency_conflict") return apiError(requestId, 409, "idempotency_conflict", "idempotency key was reused with another canonical request");
	if (result.kind === "not_found") return notFound(requestId);
	return new Response(null, { status: 204, headers: responseHeaders({ "idempotency-replayed": result.kind === "replay" ? "true" : "false" }) });
}
function withinCodePointLimit(value: string, maximum: number): boolean {
	let length = 0;
	let offset = 0;
	while (offset < value.length) {
		const codePoint = value.codePointAt(offset);
		if (codePoint === undefined) break;
		offset += codePoint > 0xffff ? 2 : 1;
		if (++length > maximum) return false;
	}
	return true;
}
function labels(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("labels must be an object");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > 32) throw new Error("labels exceeds 32 properties");
	const output: Record<string, string> = {};
	for (const [key, item] of entries) {
		if (!LABEL_KEY.test(key) || typeof item !== "string" || !withinCodePointLimit(item, 128)) throw new Error("labels is invalid");
		output[key] = item;
	}
	return output;
}
function boundedString(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || value.length < 1 || !withinCodePointLimit(value, maximum)) throw new Error(`${name} is invalid`);
	return value;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], minimum = 0): void {
	const keys = Object.keys(value);
	if (keys.length < minimum || keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error("request object fields are invalid");
}
function integerQuery(value: string | null, fallback: number, minimum: number, maximum: number): number | undefined {
	if (value === null) return fallback;
	if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}
function acceptsEventStream(value: string | null): boolean {
	if (!value) return false;
	let selectedSpecificity = -1;
	let selectedQuality = 0;
	for (const range of value.split(",")) {
		const [rawMediaType = "", ...parameters] = range.split(";");
		const mediaType = rawMediaType.trim().toLowerCase();
		const specificity = mediaType === "text/event-stream" ? 2 : mediaType === "text/*" ? 1 : mediaType === "*/*" ? 0 : -1;
		if (specificity < 0) continue;
		let quality = 1;
		let valid = true;
		let qualitySeen = false;
		for (const rawParameter of parameters) {
			const parameter = rawParameter.trim();
			const separator = parameter.indexOf("=");
			if (separator < 1) { valid = false; break; }
			const name = parameter.slice(0, separator).trim().toLowerCase();
			const parameterValue = parameter.slice(separator + 1).trim();
			if (name === "q") {
				if (qualitySeen || !/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u.test(parameterValue)) { valid = false; break; }
				qualitySeen = true;
				quality = Number(parameterValue);
			} else if (!qualitySeen) {
				valid = false;
				break;
			}
		}
		if (!valid) continue;
		if (specificity > selectedSpecificity) {
			selectedSpecificity = specificity;
			selectedQuality = quality;
		} else if (specificity === selectedSpecificity) {
			selectedQuality = Math.max(selectedQuality, quality);
		}
	}
	return selectedQuality > 0;
}

export class T4PublicApiV1 {
	readonly #ledger: PostgresLedger;
	readonly #authenticator: PrincipalAuthenticator;
	readonly #allowedOrigins: () => readonly string[];

	constructor(options: T4PublicApiV1Options) {
		this.#ledger = options.ledger;
		this.#authenticator = options.authenticator;
		const allowedOrigins = options.allowedOrigins;
		this.#allowedOrigins = typeof allowedOrigins === "function" ? allowedOrigins : () => allowedOrigins ?? [];
	}

	async handle(request: Request): Promise<Response> {
		const requestId = `req_${randomUUID()}`;
		try {
			if (new URL(request.url).protocol !== "https:") return apiError(requestId, 400, "https_required", "HTTPS is required");
			const origin = request.headers.get("origin");
			if (origin && !this.#allowedOrigins().includes(origin)) return apiError(requestId, 400, "invalid_origin", "request origin is not allowed");
			const authorization = request.headers.get("authorization");
			if (!authorization || !/^Bearer /iu.test(authorization) || authorization.length > 16_391) return apiError(requestId, 401, "unauthenticated", "valid bearer authentication is required");
			const token = authorization.slice(7);
			if (!token || /\s/u.test(token)) return apiError(requestId, 401, "unauthenticated", "valid bearer authentication is required");
			const principal = await this.#authenticator.authenticate(token);
			if (!principal || typeof principal.id !== "string" || !CRD_OWNER.test(principal.id) || !withinCodePointLimit(principal.id, 256)) return apiError(requestId, 401, "unauthenticated", "valid bearer authentication is required");
			const selectedVersion = request.headers.get("t4-api-version");
			if (!selectedVersion || selectedVersion.length > 16 || !VERSION.test(selectedVersion)) return apiError(requestId, 400, "invalid_request", "T4-API-Version is required and must be valid");
			if (selectedVersion.split(".", 1)[0] !== "1") return apiError(requestId, 406, "incompatible_version", "requested API major is unsupported", { supportedMajors: [1] });
			return await this.#route(request, new URL(request.url), { requestId, principal });
		} catch {
			return apiError(requestId, 503, "unavailable", "durable gateway is temporarily unavailable");
		}
	}

	async #route(request: Request, url: URL, context: ApiContext): Promise<Response> {
		const segments = url.pathname.split("/").filter(Boolean).map(value => {
			try { return decodeURIComponent(value); } catch { return ""; }
		});
		if (segments[0] !== "v1") return notFound(context.requestId);
		if (segments.length === 1 && request.method === "GET") {
			if (!this.#scope(context, "discovery.read")) return apiError(context.requestId, 403, "forbidden", "credential lacks the required operation scope");
			return jsonResponse(200, discoveryFor(context.principal));
		}
		if (segments.length === 2 && segments[1] === "workspaces") {
			if (request.method === "GET") return await this.#listWorkspaces(url, context);
			if (request.method === "POST") return await this.#createWorkspace(request, context);
		}
		if (segments.length === 3 && segments[1] === "workspaces" && RESOURCE_ID.test(segments[2]!)) {
			if (request.method === "GET") return await this.#getWorkspace(segments[2]!, context);
			if (request.method === "PATCH") return await this.#patchWorkspace(request, segments[2]!, context);
			if (request.method === "DELETE") return await this.#deleteWorkspace(request, segments[2]!, context);
		}
		if (segments.length === 4 && segments[1] === "workspaces" && RESOURCE_ID.test(segments[2]!) && segments[3] === "sessions") {
			if (request.method === "GET") return await this.#listSessions(url, segments[2]!, context);
			if (request.method === "POST") return await this.#createSession(request, segments[2]!, context);
		}
		if (segments.length === 3 && segments[1] === "sessions" && RESOURCE_ID.test(segments[2]!)) {
			if (request.method === "GET") return await this.#getSession(segments[2]!, context);
			if (request.method === "PATCH") return await this.#patchSession(request, segments[2]!, context);
			if (request.method === "DELETE") return await this.#cancelSession(request, segments[2]!, context, true);
		}
		if (segments.length === 4 && segments[1] === "sessions" && RESOURCE_ID.test(segments[2]!)) {
			if (segments[3] === "cancel" && request.method === "POST") return await this.#cancelSession(request, segments[2]!, context, false);
			if (segments[3] === "commands" && request.method === "POST") return await this.#submitCommand(request, segments[2]!, context);
			if (segments[3] === "snapshot" && request.method === "GET") return await this.#snapshot(segments[2]!, context);
			if (segments[3] === "events" && request.method === "GET") return await this.#events(request, url, segments[2]!, context);
		}
		return notFound(context.requestId);
	}

	#scope(context: ApiContext, required: string): boolean { return context.principal.scopes.has(required); }
	#requireScope(context: ApiContext, required: string): Response | undefined {
		return this.#scope(context, required) ? undefined : apiError(context.requestId, 403, "forbidden", "credential lacks the required operation scope");
	}
	#key(request: Request, context: ApiContext): string | Response {
		const value = request.headers.get("idempotency-key");
		return value && IDEMPOTENCY_KEY.test(value) ? value : apiError(context.requestId, 400, "idempotency_key_required", "a valid Idempotency-Key is required");
	}
	#ifMatch(request: Request, context: ApiContext): number | Response {
		const value = request.headers.get("if-match");
		if (!value || !/^[1-9][0-9]{0,15}$/u.test(value)) return apiError(context.requestId, 400, "invalid_request", "a valid If-Match revision is required");
		const revision = Number(value);
		return Number.isSafeInteger(revision) ? revision : apiError(context.requestId, 400, "invalid_request", "a valid If-Match revision is required");
	}
	async #body(request: Request, context: ApiContext): Promise<ParsedObject> {
		const contentType = request.headers.get("content-type")?.toLowerCase();
		if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)) return { response: apiError(context.requestId, 400, "invalid_request", "request content type must be application/json") };
		const announced = request.headers.get("content-length");
		if (announced && (!/^[0-9]+$/u.test(announced) || Number(announced) > DISCOVERY.limits.commandRequestBytesMax)) {
			await request.body?.cancel().catch(() => undefined);
			return { response: apiError(context.requestId, 400, "invalid_request", "request body exceeds the maximum size") };
		}
		const reader = request.body?.getReader();
		const decoder = new TextDecoder();
		let bytesRead = 0;
		let text = "";
		if (reader) {
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytesRead += chunk.value.byteLength;
					if (bytesRead > DISCOVERY.limits.commandRequestBytesMax) {
						await reader.cancel().catch(() => undefined);
						return { response: apiError(context.requestId, 400, "invalid_request", "request body exceeds the maximum size") };
					}
					text += decoder.decode(chunk.value, { stream: true });
				}
				text += decoder.decode();
			} finally {
				reader.releaseLock();
			}
		}
		let value: unknown;
		try { value = JSON.parse(text); } catch { return { response: apiError(context.requestId, 400, "invalid_request", "request body is malformed JSON") }; }
		return value && typeof value === "object" && !Array.isArray(value)
			? { value: value as Record<string, unknown> }
			: { response: apiError(context.requestId, 422, "invalid_request", "request body must be an object", { violations: [{ field: "body", rule: "type", message: "must be an object" }] }) };
	}
	#validation(context: ApiContext, message: string): Response {
		return apiError(context.requestId, 422, "invalid_request", message, { violations: [{ field: "body", rule: "schema", message }] });
	}

	async #createWorkspace(request: Request, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "workspaces.write"); if (forbidden) return forbidden;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const parsed = await this.#body(request, context); if (parsed.response) return parsed.response;
		let input: WorkspaceCreate;
		try { exactKeys(parsed.value!, ["name", "labels"], ["name"]); input = { name: boundedString(parsed.value!.name, "name", 128), ...(parsed.value!.labels !== undefined ? { labels: labels(parsed.value!.labels) } : {}) }; }
		catch (error) { return this.#validation(context, error instanceof Error ? error.message : "workspace request is invalid"); }
		const fingerprint = canonicalRequestFingerprint({ operation: "createWorkspace", target: "workspaces", body: input });
		return resultResponse(await this.#ledger.createWorkspace(context.principal.id, key, fingerprint, input), context.requestId, 202);
	}
	async #getWorkspace(workspaceId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "workspaces.read"); if (forbidden) return forbidden;
		const value = await this.#ledger.getWorkspace(context.principal.id, workspaceId);
		return value ? jsonResponse(200, value) : notFound(context.requestId);
	}
	async #listWorkspaces(url: URL, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "workspaces.read"); if (forbidden) return forbidden;
		const size = integerQuery(url.searchParams.get("pageSize"), DISCOVERY.limits.pageSizeDefault, 1, DISCOVERY.limits.pageSizeMax);
		if (!size) return this.#validation(context, "pageSize is outside the supported bounds");
		const rawCursor = url.searchParams.get("cursor");
		const after = rawCursor ? this.#ledger.readPageCursor(rawCursor, context.principal.id, "workspaces") : undefined;
		if (rawCursor && after === undefined) return this.#validation(context, "cursor is invalid for this identity and operation");
		const items = await this.#ledger.listWorkspaces(context.principal.id, after, size + 1);
		return jsonResponse(200, { items: items.slice(0, size), ...(items.length > size ? { nextCursor: this.#ledger.pageCursor(context.principal.id, "workspaces", items[size - 1]!.id) } : {}) });
	}
	async #patchWorkspace(request: Request, workspaceId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "workspaces.write"); if (forbidden) return forbidden;
		const revision = this.#ifMatch(request, context); if (revision instanceof Response) return revision;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const parsed = await this.#body(request, context); if (parsed.response) return parsed.response;
		let input: WorkspaceMutation;
		try { exactKeys(parsed.value!, ["name", "labels"], [], 1); input = { ...(parsed.value!.name !== undefined ? { name: boundedString(parsed.value!.name, "name", 128) } : {}), ...(parsed.value!.labels !== undefined ? { labels: labels(parsed.value!.labels) } : {}) }; }
		catch (error) { return this.#validation(context, error instanceof Error ? error.message : "workspace mutation is invalid"); }
		const fingerprint = canonicalRequestFingerprint({ operation: "mutateWorkspace", target: workspaceId, ifMatch: revision, body: input });
		return resultResponse(await this.#ledger.patchWorkspace(context.principal.id, workspaceId, revision, key, fingerprint, input), context.requestId, 200);
	}
	async #deleteWorkspace(request: Request, workspaceId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "workspaces.write"); if (forbidden) return forbidden;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const fingerprint = canonicalRequestFingerprint({ operation: "deleteWorkspace", target: workspaceId });
		return deletedResponse(await this.#ledger.deleteWorkspace(context.principal.id, workspaceId, key, fingerprint), context.requestId);
	}

	async #createSession(request: Request, workspaceId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "sessions.write"); if (forbidden) return forbidden;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const parsed = await this.#body(request, context); if (parsed.response) return parsed.response;
		let input: SessionCreate;
		try { exactKeys(parsed.value!, ["title", "labels"], ["title"]); input = { title: boundedString(parsed.value!.title, "title", 128), ...(parsed.value!.labels !== undefined ? { labels: labels(parsed.value!.labels) } : {}) }; }
		catch (error) { return this.#validation(context, error instanceof Error ? error.message : "session request is invalid"); }
		const fingerprint = canonicalRequestFingerprint({ operation: "spawnSession", target: workspaceId, body: input });
		return resultResponse(await this.#ledger.createSession(context.principal.id, workspaceId, key, fingerprint, input), context.requestId, 202);
	}
	async #getSession(sessionId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "sessions.read"); if (forbidden) return forbidden;
		const value = await this.#ledger.getSession(context.principal.id, sessionId);
		return value ? jsonResponse(200, value) : notFound(context.requestId);
	}
	async #listSessions(url: URL, workspaceId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "sessions.read"); if (forbidden) return forbidden;
		const size = integerQuery(url.searchParams.get("pageSize"), DISCOVERY.limits.pageSizeDefault, 1, DISCOVERY.limits.pageSizeMax);
		if (!size) return this.#validation(context, "pageSize is outside the supported bounds");
		const scope = `workspace:${workspaceId}:sessions`;
		const rawCursor = url.searchParams.get("cursor");
		const after = rawCursor ? this.#ledger.readPageCursor(rawCursor, context.principal.id, scope) : undefined;
		if (rawCursor && after === undefined) return this.#validation(context, "cursor is invalid for this identity and operation");
		const items = await this.#ledger.listSessions(context.principal.id, workspaceId, after, size + 1);
		if (!items) return notFound(context.requestId);
		return jsonResponse(200, { items: items.slice(0, size), ...(items.length > size ? { nextCursor: this.#ledger.pageCursor(context.principal.id, scope, items[size - 1]!.id) } : {}) });
	}
	async #patchSession(request: Request, sessionId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "sessions.write"); if (forbidden) return forbidden;
		const revision = this.#ifMatch(request, context); if (revision instanceof Response) return revision;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const parsed = await this.#body(request, context); if (parsed.response) return parsed.response;
		let input: SessionMutation;
		try { exactKeys(parsed.value!, ["title", "labels"], [], 1); input = { ...(parsed.value!.title !== undefined ? { title: boundedString(parsed.value!.title, "title", 128) } : {}), ...(parsed.value!.labels !== undefined ? { labels: labels(parsed.value!.labels) } : {}) }; }
		catch (error) { return this.#validation(context, error instanceof Error ? error.message : "session mutation is invalid"); }
		const fingerprint = canonicalRequestFingerprint({ operation: "mutateSession", target: sessionId, ifMatch: revision, body: input });
		return resultResponse(await this.#ledger.patchSession(context.principal.id, sessionId, revision, key, fingerprint, input), context.requestId, 200);
	}
	async #cancelSession(request: Request, sessionId: string, context: ApiContext, deletion: boolean): Promise<Response> {
		const forbidden = this.#requireScope(context, "sessions.write"); if (forbidden) return forbidden;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const fingerprint = canonicalRequestFingerprint({ operation: deletion ? "deleteSession" : "cancelSession", target: sessionId });
		const result = await this.#ledger.cancelSession(context.principal.id, sessionId, key, fingerprint, deletion);
		return deletion ? deletedResponse(result, context.requestId) : resultResponse(result, context.requestId, 202);
	}
	async #submitCommand(request: Request, sessionId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "commands.write"); if (forbidden) return forbidden;
		const key = this.#key(request, context); if (key instanceof Response) return key;
		const parsed = await this.#body(request, context); if (parsed.response) return parsed.response;
		let input: CommandCreate;
		try {
			exactKeys(parsed.value!, ["command", "metadata"], ["command"]);
			const command = boundedString(parsed.value!.command, "command", 262_144);
			if (encoder.encode(command).byteLength > DISCOVERY.limits.commandBytesMax) throw new Error("command exceeds UTF-8 byte limit");
			const metadataValue = parsed.value!.metadata ?? {};
			if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue) || Object.keys(metadataValue).length > 32) throw new Error("metadata is invalid");
			const metadata: Record<string, string | number | boolean | null> = {};
			for (const [metadataKey, value] of Object.entries(metadataValue as Record<string, unknown>)) {
				if (!LABEL_KEY.test(metadataKey) || value !== null && !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && (!Number.isSafeInteger(value) || !Number.isFinite(value))) throw new Error("metadata is invalid");
				if (typeof value === "string" && encoder.encode(value).byteLength > DISCOVERY.limits.commandMetadataValueBytesMax) throw new Error("metadata value exceeds UTF-8 byte limit");
				metadata[metadataKey] = value as string | number | boolean | null;
			}
			input = { command, metadata };
		} catch (error) { return this.#validation(context, error instanceof Error ? error.message : "command request is invalid"); }
		const fingerprint = canonicalRequestFingerprint({ operation: "submitCommand", target: sessionId, body: input });
		return resultResponse(await this.#ledger.submitCommand(context.principal.id, sessionId, key, fingerprint, { command: input.command, metadata: input.metadata ?? {} }), context.requestId, 202);
	}
	async #snapshot(sessionId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "events.read"); if (forbidden) return forbidden;
		const snapshot = await this.#ledger.snapshot(context.principal.id, sessionId);
		return snapshot ? jsonResponse(200, { sessionId, cursor: snapshot.cursor, state: snapshot.session.state, entries: snapshot.entries }) : notFound(context.requestId);
	}
	async #events(request: Request, url: URL, sessionId: string, context: ApiContext): Promise<Response> {
		const forbidden = this.#requireScope(context, "events.read"); if (forbidden) return forbidden;
		if (!acceptsEventStream(request.headers.get("accept"))) return apiError(context.requestId, 406, "incompatible_version", "Accept must allow text/event-stream", { supportedMajors: [1] });
		const maxEvents = integerQuery(url.searchParams.get("maxEvents"), 100, 1, DISCOVERY.limits.watchEventsMax);
		const heartbeat = integerQuery(url.searchParams.get("heartbeatSeconds"), DISCOVERY.limits.heartbeatSeconds, 5, 60);
		if (!maxEvents || !heartbeat) return this.#validation(context, "watch bounds are invalid");
		const hasQueryCursor = url.searchParams.has("cursor");
		const queryCursor = url.searchParams.get("cursor");
		const headerCursor = request.headers.get("last-event-id");
		if ((hasQueryCursor && !queryCursor) || (headerCursor !== null && !headerCursor)) return this.#validation(context, "watch cursor is invalid for this identity and session");
		if (hasQueryCursor && headerCursor !== null && queryCursor !== headerCursor) return apiError(context.requestId, 400, "invalid_request", "cursor and Last-Event-ID must agree");
		let window;
		try { window = await this.#ledger.eventWindow(context.principal.id, sessionId, queryCursor ?? headerCursor ?? undefined, maxEvents); }
		catch (error) {
			if (error instanceof Error && error.message === "invalid_cursor") return this.#validation(context, "watch cursor is invalid for this identity and session");
			throw error;
		}
		if (!window) return notFound(context.requestId);
		if (window.expired) return apiError(context.requestId, 410, "cursor_expired", "watch cursor is outside retained history", { resync: { snapshotUrl: `/v1/sessions/${sessionId}/snapshot`, cursor: window.resyncCursor } });
		const frames: string[] = [];
		for (const event of window.events) {
			const cursor = this.#ledger.watchCursor(context.principal.id, sessionId, event.sequence);
			const data = event.type === "session"
				? { type: "session", cursor, state: event.payload.state, revision: event.payload.revision }
				: { type: "command", cursor, commandId: event.payload.commandId, state: event.payload.state };
			frames.push(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
		}
		if (frames.length === 0) {
			const data = { type: "heartbeat", cursor: window.cursor, observedAt: new Date().toISOString() };
			frames.push(`id: ${window.cursor}\nevent: heartbeat\ndata: ${JSON.stringify(data)}\n\n`);
		}
		return new Response(frames.join(""), { status: 200, headers: responseHeaders({ "content-type": "text/event-stream" }) });
	}
}
