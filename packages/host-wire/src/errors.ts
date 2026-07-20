export type AppWireErrorCode =
	| "INVALID_JSON"
	| "INVALID_FRAME"
	| "OVERSIZED_INPUT"
	| "UNSAFE_SEQUENCE"
	| "MISSING_VERSION"
	| "UNKNOWN_FRAME"
	| "BOUNDS"
	| "UNSAFE_PATH"
	| "UNSUPPORTED_PROTOCOL"
	| "IDEMPOTENCY_CONFLICT"
	| "STALE_REVISION"
	| "OUTCOME_UNKNOWN"
	| "CONFIRMATION_INVALID"
	| "PAIRING_INVALID";

export class AppWireError extends Error {
	override readonly name = "AppWireError";
	readonly code: AppWireErrorCode;
	readonly path: string | undefined;
	constructor(code: AppWireErrorCode, message: string, path?: string) {
		super(message);
		this.code = code;
		this.path = path;
	}
}
export function fail(code: AppWireErrorCode, message: string, path?: string): never {
	throw new AppWireError(code, message, path);
}
