import { fail } from "./errors.js";
import { boundedArray, controlFree, inputObject, safeRelativePath } from "./guards.js";

export const PROJECT_FILE_SEARCH_MAX_QUERY_BYTES = 256;
export const PROJECT_FILE_SEARCH_DEFAULT_LIMIT = 12;
export const PROJECT_FILE_SEARCH_MAX_RESULTS = 50;

export interface ProjectFileSearchArguments {
	readonly query: string;
	readonly limit?: number;
}

export interface ProjectFileSearchMatch {
	readonly path: string;
}

export interface ProjectFileSearchResult {
	readonly matches: readonly ProjectFileSearchMatch[];
	readonly truncated: boolean;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const permitted = new Set(allowed);
	for (const key of Object.keys(value))
		if (!permitted.has(key)) fail("INVALID_FRAME", "unknown field", `${path}.${key}`);
}

export function decodeProjectFileSearchArguments(value: unknown): ProjectFileSearchArguments {
	const input = inputObject(value);
	exactKeys(input, ["query", "limit"], "args");
	const query = controlFree(input.query, "args.query", PROJECT_FILE_SEARCH_MAX_QUERY_BYTES).trim();
	if (query.length === 0) fail("INVALID_FRAME", "query must not be blank", "args.query");
	if (input.limit === undefined) return { query };
	if (
		typeof input.limit !== "number" ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > PROJECT_FILE_SEARCH_MAX_RESULTS
	)
		fail("BOUNDS", "limit is outside the allowed range", "args.limit");
	return { query, limit: input.limit };
}

export function decodeProjectFileSearchResult(value: unknown): ProjectFileSearchResult {
	const input = inputObject(value);
	exactKeys(input, ["matches", "truncated"], "result");
	if (typeof input.truncated !== "boolean")
		fail("INVALID_FRAME", "truncated must be boolean", "result.truncated");
	const seen = new Set<string>();
	const matches = boundedArray(input.matches, "result.matches", PROJECT_FILE_SEARCH_MAX_RESULTS).map(
		(value, index): ProjectFileSearchMatch => {
			const match = inputObject(value);
			exactKeys(match, ["path"], `result.matches[${index}]`);
			const path = safeRelativePath(match.path, `result.matches[${index}].path`);
			if (seen.has(path)) fail("INVALID_FRAME", "duplicate search result", `result.matches[${index}].path`);
			seen.add(path);
			return { path };
		},
	);
	return { matches, truncated: input.truncated };
}
