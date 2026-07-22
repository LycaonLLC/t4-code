import type { CredentialHeader } from "./config.ts";

const ALLOWED_METHODS = new Set(["GET", "POST"]);
const REQUEST_HEADERS_REMOVED = new Set([
	"authorization",
	"x-api-key",
	"api-key",
	"cookie",
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"forwarded",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-port",
	"x-forwarded-proto",
]);
const RESPONSE_HEADERS_REMOVED = new Set([
	"set-cookie",
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export interface GatewayLogEvent {
	readonly result: "success" | "rejected" | "upstream_error";
	readonly method: string;
	readonly status: number;
	readonly durationMs: number;
}

export interface GatewayHandlerOptions {
	readonly upstreamOrigin: URL;
	readonly credentialHeader: CredentialHeader;
	readonly credentialValue?: string;
	readonly credential?: () => Promise<string>;
	readonly allowedPaths: readonly string[];
	readonly timeoutMs: number;
	readonly maxRequestBodyBytes: number;
	readonly fetch?: typeof globalThis.fetch;
	readonly log?: (event: GatewayLogEvent) => void;
	readonly now?: () => number;
}

function plain(status: number, message: string): Response {
	return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function filteredHeaders(source: Headers, removed: ReadonlySet<string>): Headers {
	const headers = new Headers();
	for (const [name, value] of source) {
		if (!removed.has(name.toLowerCase())) headers.append(name, value);
	}
	return headers;
}

export function createGatewayHandler(options: GatewayHandlerOptions): (request: Request) => Promise<Response> {
	if (Boolean(options.credentialValue) === Boolean(options.credential)) {
		throw new Error("model gateway requires exactly one credential source");
	}
	const fetch = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const allowedPaths = new Set(options.allowedPaths);
	if (allowedPaths.size === 0 || allowedPaths.size !== options.allowedPaths.length) {
		throw new Error("model gateway requires unique allowed paths");
	}
	return async request => {
		const started = now();
		const method = request.method.toUpperCase();
		const finish = (response: Response, result: GatewayLogEvent["result"]): Response => {
			options.log?.({ result, method, status: response.status, durationMs: Math.max(0, now() - started) });
			return response;
		};
		if (!ALLOWED_METHODS.has(method)) return finish(plain(405, "method not allowed"), "rejected");
		const contentLength = request.headers.get("content-length");
		if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > options.maxRequestBodyBytes)) {
			return finish(plain(413, "request body too large"), "rejected");
		}
		const incoming = new URL(request.url);
		if (incoming.pathname.startsWith("//") || incoming.pathname.includes("\\")) {
			return finish(plain(400, "request target is invalid"), "rejected");
		}
		if (!allowedPaths.has(incoming.pathname)) return finish(plain(404, "model endpoint not allowed"), "rejected");
		const target = new URL(`${incoming.pathname}${incoming.search}`, options.upstreamOrigin);
		if (target.origin !== options.upstreamOrigin.origin) {
			return finish(plain(400, "request target is invalid"), "rejected");
		}
		try {
			const headers = filteredHeaders(request.headers, REQUEST_HEADERS_REMOVED);
			headers.set(options.credentialHeader, options.credentialValue ?? await options.credential!());
			const response = await fetch(target, {
				method,
				headers,
				body: method === "POST" ? request.body : undefined,
				redirect: "manual",
				signal: AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)]),
			});
			if (response.status >= 300 && response.status < 400) {
				void response.body?.cancel();
				return finish(plain(502, "upstream redirect rejected"), "upstream_error");
			}
			return finish(new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: filteredHeaders(response.headers, RESPONSE_HEADERS_REMOVED),
			}), "success");
		} catch {
			return finish(plain(502, "upstream request failed"), "upstream_error");
		}
	};
}
