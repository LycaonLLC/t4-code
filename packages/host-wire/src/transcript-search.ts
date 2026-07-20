import { fail } from "./errors.js";
import { boundedArray, boundedMap, boundedText, controlFree, safeSeq } from "./guards.js";
import { type EntryId, entryId, type ProjectId, projectId, type SessionId, sessionId } from "./ids.js";

export const TRANSCRIPT_SEARCH_MAX_QUERY_BYTES = 512;
export const TRANSCRIPT_SEARCH_MAX_CURSOR_BYTES = 2_048;
export const TRANSCRIPT_SEARCH_MAX_RESULTS = 50;
export const TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES = 768;
export const TRANSCRIPT_SEARCH_MAX_HIGHLIGHTS = 32;
export const TRANSCRIPT_CONTEXT_MAX_SIDE_ROWS = 20;
export const TRANSCRIPT_CONTEXT_MAX_ROWS = 41;
export const TRANSCRIPT_CONTEXT_MAX_TEXT_BYTES = 16_384;
export const TRANSCRIPT_SEARCH_MAX_GENERATION_BYTES = 128;

export const TRANSCRIPT_SEARCH_ROLES = ["user", "assistant", "summary"] as const;
export type TranscriptSearchRole = (typeof TRANSCRIPT_SEARCH_ROLES)[number];
export const TRANSCRIPT_SEARCH_ARCHIVED_FILTERS = ["include", "only", "exclude"] as const;
export type TranscriptSearchArchivedFilter = (typeof TRANSCRIPT_SEARCH_ARCHIVED_FILTERS)[number];
export const TRANSCRIPT_SEARCH_INDEX_STATES = ["building", "ready", "stale"] as const;
export type TranscriptSearchIndexState = (typeof TRANSCRIPT_SEARCH_INDEX_STATES)[number];

export interface TranscriptSearchArguments {
	readonly query: string;
	readonly limit?: number;
	readonly cursor?: string;
	readonly projectId?: ProjectId;
	readonly roles?: readonly TranscriptSearchRole[];
	readonly archived?: TranscriptSearchArchivedFilter;
	readonly from?: string;
	readonly to?: string;
}

export interface TranscriptSearchHighlight {
	readonly start: number;
	readonly end: number;
}

export interface TranscriptSearchItem {
	readonly sessionId: SessionId;
	readonly projectId: ProjectId;
	readonly sessionTitle: string;
	readonly archivedAt?: string;
	readonly anchorId: EntryId;
	readonly role: TranscriptSearchRole;
	readonly timestamp: string;
	readonly snippet: string;
	readonly highlights: readonly TranscriptSearchHighlight[];
}

export interface TranscriptSearchIndexStatus {
	readonly state: TranscriptSearchIndexState;
	readonly indexedSessions: number;
	readonly knownSessions: number;
	readonly generation: string;
}

export interface TranscriptSearchResult {
	readonly items: readonly TranscriptSearchItem[];
	readonly nextCursor?: string;
	readonly incomplete: boolean;
	readonly index: TranscriptSearchIndexStatus;
}

export interface TranscriptContextArguments {
	readonly anchorId: EntryId;
	readonly before?: number;
	readonly after?: number;
}

export interface TranscriptContextRow {
	readonly anchorId: EntryId;
	readonly role: TranscriptSearchRole;
	readonly timestamp: string;
	readonly text: string;
}

export interface TranscriptContextResult {
	readonly anchorId: EntryId;
	readonly rows: readonly TranscriptContextRow[];
	readonly anchorIndex: number;
	readonly hasBefore: boolean;
	readonly hasAfter: boolean;
	readonly generation: string;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value))
		if (!allowedKeys.has(key)) fail("INVALID_FRAME", "unknown transcript search field", `${path}.${key}`);
}

function canonicalTimestamp(value: unknown, path: string): string {
	const timestamp = controlFree(value, path, 128);
	const milliseconds = Date.parse(timestamp);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp)
		fail("INVALID_FRAME", "timestamp must be canonical ISO", path);
	return timestamp;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
	const text = controlFree(value, path, 128);
	if (!(values as readonly string[]).includes(text)) fail("INVALID_FRAME", "unknown enum value", path);
	return text as T[number];
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
	const integer = safeSeq(value, path);
	if (integer < min || integer > max) fail("BOUNDS", `integer must be between ${min} and ${max}`, path);
	return integer;
}

export function decodeTranscriptSearchArguments(value: unknown): TranscriptSearchArguments {
	const input = boundedMap(value, "args");
	exactKeys(input, ["query", "limit", "cursor", "projectId", "roles", "archived", "from", "to"], "args");
	const query = boundedText(input.query, "args.query", TRANSCRIPT_SEARCH_MAX_QUERY_BYTES);
	if (query.trim().length === 0) fail("BOUNDS", "query must not be blank", "args.query");
	const limit =
		input.limit === undefined
			? undefined
			: boundedInteger(input.limit, "args.limit", 1, TRANSCRIPT_SEARCH_MAX_RESULTS);
	const cursor =
		input.cursor === undefined
			? undefined
			: controlFree(input.cursor, "args.cursor", TRANSCRIPT_SEARCH_MAX_CURSOR_BYTES);
	const project = input.projectId === undefined ? undefined : projectId(input.projectId, "args.projectId");
	let roles: TranscriptSearchRole[] | undefined;
	if (input.roles !== undefined) {
		const rawRoles = boundedArray(input.roles, "args.roles", TRANSCRIPT_SEARCH_ROLES.length);
		if (rawRoles.length === 0) fail("BOUNDS", "roles must not be empty", "args.roles");
		roles = rawRoles.map((role, index) => enumValue(role, TRANSCRIPT_SEARCH_ROLES, `args.roles[${index}]`));
		if (new Set(roles).size !== roles.length) fail("INVALID_FRAME", "roles must be unique", "args.roles");
	}
	const archived =
		input.archived === undefined
			? undefined
			: enumValue(input.archived, TRANSCRIPT_SEARCH_ARCHIVED_FILTERS, "args.archived");
	const from = input.from === undefined ? undefined : canonicalTimestamp(input.from, "args.from");
	const to = input.to === undefined ? undefined : canonicalTimestamp(input.to, "args.to");
	if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to))
		fail("BOUNDS", "from must not be later than to", "args.from");
	return {
		query,
		...(limit === undefined ? {} : { limit }),
		...(cursor === undefined ? {} : { cursor }),
		...(project === undefined ? {} : { projectId: project }),
		...(roles === undefined ? {} : { roles }),
		...(archived === undefined ? {} : { archived }),
		...(from === undefined ? {} : { from }),
		...(to === undefined ? {} : { to }),
	};
}

function decodeHighlight(value: unknown, path: string, snippetLength: number): TranscriptSearchHighlight {
	const input = boundedMap(value, path);
	exactKeys(input, ["start", "end"], path);
	const start = safeSeq(input.start, `${path}.start`);
	const end = safeSeq(input.end, `${path}.end`);
	if (start >= end || end > snippetLength)
		fail("BOUNDS", "highlight must be a non-empty range within the snippet", path);
	return { start, end };
}

function decodeSearchItem(value: unknown, path: string): TranscriptSearchItem {
	const input = boundedMap(value, path);
	exactKeys(
		input,
		[
			"sessionId",
			"projectId",
			"sessionTitle",
			"archivedAt",
			"anchorId",
			"role",
			"timestamp",
			"snippet",
			"highlights",
		],
		path,
	);
	const snippet = boundedText(input.snippet, `${path}.snippet`, TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES);
	return {
		sessionId: sessionId(input.sessionId, `${path}.sessionId`),
		projectId: projectId(input.projectId, `${path}.projectId`),
		sessionTitle: boundedText(input.sessionTitle, `${path}.sessionTitle`, 512),
		...(input.archivedAt === undefined
			? {}
			: { archivedAt: canonicalTimestamp(input.archivedAt, `${path}.archivedAt`) }),
		anchorId: entryId(input.anchorId, `${path}.anchorId`),
		role: enumValue(input.role, TRANSCRIPT_SEARCH_ROLES, `${path}.role`),
		timestamp: canonicalTimestamp(input.timestamp, `${path}.timestamp`),
		snippet,
		highlights: boundedArray(input.highlights, `${path}.highlights`, TRANSCRIPT_SEARCH_MAX_HIGHLIGHTS).map(
			(highlight, index) => decodeHighlight(highlight, `${path}.highlights[${index}]`, snippet.length),
		),
	};
}

function decodeIndexStatus(value: unknown): TranscriptSearchIndexStatus {
	const input = boundedMap(value, "result.index");
	exactKeys(input, ["state", "indexedSessions", "knownSessions", "generation"], "result.index");
	const indexedSessions = safeSeq(input.indexedSessions, "result.index.indexedSessions");
	const knownSessions = safeSeq(input.knownSessions, "result.index.knownSessions");
	if (indexedSessions > knownSessions)
		fail("INVALID_FRAME", "indexedSessions must not exceed knownSessions", "result.index.indexedSessions");
	return {
		state: enumValue(input.state, TRANSCRIPT_SEARCH_INDEX_STATES, "result.index.state"),
		indexedSessions,
		knownSessions,
		generation: controlFree(input.generation, "result.index.generation", TRANSCRIPT_SEARCH_MAX_GENERATION_BYTES),
	};
}

export function decodeTranscriptSearchResult(value: unknown): TranscriptSearchResult {
	const input = boundedMap(value, "result");
	exactKeys(input, ["items", "nextCursor", "incomplete", "index"], "result");
	const items = boundedArray(input.items, "result.items", TRANSCRIPT_SEARCH_MAX_RESULTS).map((item, index) =>
		decodeSearchItem(item, `result.items[${index}]`),
	);
	const nextCursor =
		input.nextCursor === undefined
			? undefined
			: controlFree(input.nextCursor, "result.nextCursor", TRANSCRIPT_SEARCH_MAX_CURSOR_BYTES);
	if (typeof input.incomplete !== "boolean") fail("INVALID_FRAME", "incomplete must be boolean", "result.incomplete");
	return {
		items,
		...(nextCursor === undefined ? {} : { nextCursor }),
		incomplete: input.incomplete,
		index: decodeIndexStatus(input.index),
	};
}

export function decodeTranscriptContextArguments(value: unknown): TranscriptContextArguments {
	const input = boundedMap(value, "args");
	exactKeys(input, ["anchorId", "before", "after"], "args");
	const before =
		input.before === undefined
			? undefined
			: boundedInteger(input.before, "args.before", 0, TRANSCRIPT_CONTEXT_MAX_SIDE_ROWS);
	const after =
		input.after === undefined
			? undefined
			: boundedInteger(input.after, "args.after", 0, TRANSCRIPT_CONTEXT_MAX_SIDE_ROWS);
	return {
		anchorId: entryId(input.anchorId, "args.anchorId"),
		...(before === undefined ? {} : { before }),
		...(after === undefined ? {} : { after }),
	};
}

function decodeContextRow(value: unknown, path: string): TranscriptContextRow {
	const input = boundedMap(value, path);
	exactKeys(input, ["anchorId", "role", "timestamp", "text"], path);
	return {
		anchorId: entryId(input.anchorId, `${path}.anchorId`),
		role: enumValue(input.role, TRANSCRIPT_SEARCH_ROLES, `${path}.role`),
		timestamp: canonicalTimestamp(input.timestamp, `${path}.timestamp`),
		text: boundedText(input.text, `${path}.text`, TRANSCRIPT_CONTEXT_MAX_TEXT_BYTES),
	};
}

export function decodeTranscriptContextResult(value: unknown): TranscriptContextResult {
	const input = boundedMap(value, "result");
	exactKeys(input, ["anchorId", "rows", "anchorIndex", "hasBefore", "hasAfter", "generation"], "result");
	const anchor = entryId(input.anchorId, "result.anchorId");
	const rows = boundedArray(input.rows, "result.rows", TRANSCRIPT_CONTEXT_MAX_ROWS).map((row, index) =>
		decodeContextRow(row, `result.rows[${index}]`),
	);
	const anchorIndex = safeSeq(input.anchorIndex, "result.anchorIndex");
	if (anchorIndex >= rows.length || rows[anchorIndex]?.anchorId !== anchor)
		fail("INVALID_FRAME", "anchorIndex must identify the matching anchor row", "result.anchorIndex");
	if (typeof input.hasBefore !== "boolean") fail("INVALID_FRAME", "hasBefore must be boolean", "result.hasBefore");
	if (typeof input.hasAfter !== "boolean") fail("INVALID_FRAME", "hasAfter must be boolean", "result.hasAfter");
	return {
		anchorId: anchor,
		rows,
		anchorIndex,
		hasBefore: input.hasBefore,
		hasAfter: input.hasAfter,
		generation: controlFree(input.generation, "result.generation", TRANSCRIPT_SEARCH_MAX_GENERATION_BYTES),
	};
}
