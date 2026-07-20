import { fail } from "./errors.js";
import { boundedArray, boundedMap, controlFree, finiteNumber, isSecretLikeKey, utf8ByteLength } from "./guards.js";

export const USAGE_RESULT_MAX_BYTES = 512 * 1024;
export const USAGE_MAX_REPORTS = 64;
export const USAGE_MAX_LIMITS_PER_REPORT = 32;
export const USAGE_MAX_ACCOUNTS_WITHOUT_REPORT = 128;
export const USAGE_MAX_PROVIDER_NOTES = 8;
export const USAGE_MAX_LIMIT_NOTES = 8;
export const USAGE_MAX_RESET_CREDITS = 64;
export const USAGE_MAX_CAPACITY_PROVIDERS = 64;
export const USAGE_MAX_CAPACITY_ACCOUNTS = USAGE_MAX_REPORTS * USAGE_MAX_LIMITS_PER_REPORT;
export const USAGE_MAX_CAPACITY_WINDOWS = USAGE_MAX_LIMITS_PER_REPORT;

const USAGE_UNITS = ["percent", "tokens", "requests", "usd", "minutes", "bytes", "unknown"] as const;
const USAGE_STATUSES = ["ok", "warning", "exhausted", "unknown"] as const;
const USAGE_ACCOUNT_TYPES = ["api_key", "oauth"] as const;
const USAGE_METADATA_STRING_KEYS = [
	"email",
	"accountId",
	"projectId",
	"orgId",
	"orgName",
	"planType",
	"plan",
	"currentTierId",
	"currentTierName",
	"source",
	"period",
	"quotaResetDate",
] as const;
const USAGE_METADATA_BOOLEAN_KEYS = ["allowed", "limitReached"] as const;

export type UsageWireUnit = (typeof USAGE_UNITS)[number];
export type UsageWireStatus = (typeof USAGE_STATUSES)[number];
export type UsageWireAccountType = (typeof USAGE_ACCOUNT_TYPES)[number];
export type UsageWireMetadataStringKey = (typeof USAGE_METADATA_STRING_KEYS)[number];
export type UsageWireMetadataBooleanKey = (typeof USAGE_METADATA_BOOLEAN_KEYS)[number];

export interface UsageWireWindow {
	readonly id: string;
	readonly label: string;
	readonly durationMs?: number;
	readonly resetsAt?: number;
}

export interface UsageWireAmount {
	readonly used?: number;
	readonly limit?: number;
	readonly remaining?: number;
	readonly usedFraction?: number;
	readonly remainingFraction?: number;
	readonly unit: UsageWireUnit;
}

export interface UsageWireScope {
	readonly provider: string;
	readonly accountId?: string;
	readonly projectId?: string;
	readonly orgId?: string;
	readonly modelId?: string;
	readonly tier?: string;
	readonly windowId?: string;
	readonly shared?: boolean;
}

export interface UsageWireLimit {
	readonly id: string;
	readonly label: string;
	readonly scope: UsageWireScope;
	readonly window?: UsageWireWindow;
	readonly amount: UsageWireAmount;
	readonly status?: UsageWireStatus;
	readonly notes?: readonly string[];
}

export interface UsageWireResetCredit {
	readonly grantedAt?: string;
	readonly expiresAt?: string;
	readonly status?: string;
}

export interface UsageWireResetCredits {
	readonly availableCount: number;
	readonly credits?: readonly UsageWireResetCredit[];
}

export type UsageWireMetadata = Partial<Record<UsageWireMetadataStringKey, string>> &
	Partial<Record<UsageWireMetadataBooleanKey, boolean>>;

export interface UsageWireReport {
	readonly provider: string;
	readonly fetchedAt: number;
	readonly limits: readonly UsageWireLimit[];
	readonly resetCredits?: UsageWireResetCredits;
	readonly notes?: readonly string[];
	readonly metadata?: UsageWireMetadata;
}

export interface UsageWireAccountWithoutReport {
	readonly provider: string;
	readonly type: UsageWireAccountType;
	readonly email?: string;
	readonly accountId?: string;
	readonly projectId?: string;
	readonly enterpriseUrl?: string;
	readonly orgId?: string;
	readonly orgName?: string;
}

export interface UsageWireCapacityWindow {
	readonly window: string;
	readonly durationMs?: number;
	readonly accounts: number;
	readonly usedAccounts: number;
	readonly remainingAccounts: number;
}

export interface UsageReadResult {
	readonly generatedAt: number;
	readonly reports: readonly UsageWireReport[];
	readonly accountsWithoutUsage: readonly UsageWireAccountWithoutReport[];
	readonly capacity: Readonly<Record<string, readonly UsageWireCapacityWindow[]>>;
}

function strictObject(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
	const result = boundedMap(value, path, allowed.length);
	const expected = new Set(allowed);
	for (const key of Object.keys(result))
		if (!expected.has(key)) fail("INVALID_FRAME", "unknown usage field", `${path}.${key}`);
	return result;
}

function requiredFields(value: Record<string, unknown>, path: string, required: readonly string[]): void {
	for (const key of required)
		if (!Object.hasOwn(value, key)) fail("INVALID_FRAME", "missing usage field", `${path}.${key}`);
}

function optionalDisplayText(value: unknown, path: string, max = 512): string | undefined {
	return value === undefined ? undefined : controlFree(value, path, max);
}
function isoTimestamp(value: unknown, path: string): string {
	const text = controlFree(value, path, 64);
	if (!Number.isFinite(Date.parse(text))) fail("INVALID_FRAME", "timestamp must be parseable ISO text", path);
	return text;
}

function boundedNumber(value: unknown, path: string, min: number, max: number): number {
	const result = finiteNumber(value, path);
	if (result < min || result > max) fail("BOUNDS", "usage number is outside its allowed range", path);
	return result;
}

function timestamp(value: unknown, path: string): number {
	const result = boundedNumber(value, path, 0, 8_640_000_000_000_000);
	if (!Number.isSafeInteger(result)) fail("BOUNDS", "usage timestamp must be a safe integer", path);
	return result;
}

function duration(value: unknown, path: string): number {
	const result = boundedNumber(value, path, 0, 315_576_000_000);
	if (!Number.isSafeInteger(result)) fail("BOUNDS", "usage duration must be a safe integer", path);
	return result;
}

function count(value: unknown, path: string, max: number): number {
	const result = boundedNumber(value, path, 0, max);
	if (!Number.isSafeInteger(result)) fail("BOUNDS", "usage count must be a safe integer", path);
	return result;
}

function enumValue<const T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
	const result = controlFree(value, path, 64);
	if (!(values as readonly string[]).includes(result)) fail("INVALID_FRAME", "unknown usage enum value", path);
	return result as T[number];
}

function displayNotes(value: unknown, path: string, max: number): string[] {
	return boundedArray(value, path, max).map((note, index) => controlFree(note, `${path}[${index}]`, 1024));
}

function decodeWindow(value: unknown, path: string): UsageWireWindow {
	const input = strictObject(value, path, ["id", "label", "durationMs", "resetsAt"]);
	requiredFields(input, path, ["id", "label"]);
	return {
		id: controlFree(input.id, `${path}.id`, 256),
		label: controlFree(input.label, `${path}.label`, 512),
		...(input.durationMs === undefined ? {} : { durationMs: duration(input.durationMs, `${path}.durationMs`) }),
		...(input.resetsAt === undefined ? {} : { resetsAt: timestamp(input.resetsAt, `${path}.resetsAt`) }),
	};
}

function decodeAmount(value: unknown, path: string): UsageWireAmount {
	const input = strictObject(value, path, ["used", "limit", "remaining", "usedFraction", "remainingFraction", "unit"]);
	requiredFields(input, path, ["unit"]);
	const amount = (field: string): number | undefined =>
		input[field] === undefined
			? undefined
			: boundedNumber(input[field], `${path}.${field}`, -1_000_000_000_000_000, 1_000_000_000_000_000);
	const used = amount("used");
	const limit = amount("limit");
	const remaining = amount("remaining");
	const usedFraction = amount("usedFraction");
	const remainingFraction = amount("remainingFraction");
	return {
		...(used === undefined ? {} : { used }),
		...(limit === undefined ? {} : { limit }),
		...(remaining === undefined ? {} : { remaining }),
		...(usedFraction === undefined ? {} : { usedFraction }),
		...(remainingFraction === undefined ? {} : { remainingFraction }),
		unit: enumValue(input.unit, `${path}.unit`, USAGE_UNITS),
	};
}

function decodeScope(value: unknown, path: string): UsageWireScope {
	const input = strictObject(value, path, [
		"provider",
		"accountId",
		"projectId",
		"orgId",
		"modelId",
		"tier",
		"windowId",
		"shared",
	]);
	requiredFields(input, path, ["provider"]);
	const optional = (field: string, max = 512): string | undefined =>
		optionalDisplayText(input[field], `${path}.${field}`, max);
	const accountId = optional("accountId");
	const projectId = optional("projectId");
	const orgId = optional("orgId");
	const modelId = optional("modelId");
	const tier = optional("tier", 256);
	const windowId = optional("windowId", 256);
	if (input.shared !== undefined && typeof input.shared !== "boolean")
		fail("INVALID_FRAME", "shared must be boolean", `${path}.shared`);
	return {
		provider: controlFree(input.provider, `${path}.provider`, 128),
		...(accountId === undefined ? {} : { accountId }),
		...(projectId === undefined ? {} : { projectId }),
		...(orgId === undefined ? {} : { orgId }),
		...(modelId === undefined ? {} : { modelId }),
		...(tier === undefined ? {} : { tier }),
		...(windowId === undefined ? {} : { windowId }),
		...(input.shared === undefined ? {} : { shared: input.shared }),
	};
}

function decodeLimit(value: unknown, path: string, provider: string): UsageWireLimit {
	const input = strictObject(value, path, ["id", "label", "scope", "window", "amount", "status", "notes"]);
	requiredFields(input, path, ["id", "label", "scope", "amount"]);
	const scope = decodeScope(input.scope, `${path}.scope`);
	if (scope.provider !== provider)
		fail("INVALID_FRAME", "usage limit provider does not match its report", `${path}.scope.provider`);
	return {
		id: controlFree(input.id, `${path}.id`, 256),
		label: controlFree(input.label, `${path}.label`, 512),
		scope,
		...(input.window === undefined ? {} : { window: decodeWindow(input.window, `${path}.window`) }),
		amount: decodeAmount(input.amount, `${path}.amount`),
		...(input.status === undefined ? {} : { status: enumValue(input.status, `${path}.status`, USAGE_STATUSES) }),
		...(input.notes === undefined
			? {}
			: { notes: displayNotes(input.notes, `${path}.notes`, USAGE_MAX_LIMIT_NOTES) }),
	};
}

function decodeResetCredit(value: unknown, path: string): UsageWireResetCredit {
	const input = strictObject(value, path, ["grantedAt", "expiresAt", "status"]);
	return {
		...(input.grantedAt === undefined ? {} : { grantedAt: isoTimestamp(input.grantedAt, `${path}.grantedAt`) }),
		...(input.expiresAt === undefined ? {} : { expiresAt: isoTimestamp(input.expiresAt, `${path}.expiresAt`) }),
		...(input.status === undefined ? {} : { status: controlFree(input.status, `${path}.status`, 64) }),
	};
}

function decodeResetCredits(value: unknown, path: string): UsageWireResetCredits {
	const input = strictObject(value, path, ["availableCount", "credits"]);
	requiredFields(input, path, ["availableCount"]);
	return {
		availableCount: count(input.availableCount, `${path}.availableCount`, USAGE_MAX_RESET_CREDITS),
		...(input.credits === undefined
			? {}
			: {
					credits: boundedArray(input.credits, `${path}.credits`, USAGE_MAX_RESET_CREDITS).map((credit, index) =>
						decodeResetCredit(credit, `${path}.credits[${index}]`),
					),
				}),
	};
}

function decodeMetadata(value: unknown, path: string): UsageWireMetadata {
	const allowed = [...USAGE_METADATA_STRING_KEYS, ...USAGE_METADATA_BOOLEAN_KEYS];
	const input = strictObject(value, path, allowed);
	const output: Record<string, string | boolean> = {};
	for (const key of Object.keys(input))
		if (isSecretLikeKey(key)) fail("INVALID_FRAME", "secret-like usage metadata is forbidden", `${path}.${key}`);
	for (const key of USAGE_METADATA_STRING_KEYS) {
		const field = optionalDisplayText(input[key], `${path}.${key}`, key === "email" ? 512 : 256);
		if (field !== undefined) output[key] = field;
	}
	for (const key of USAGE_METADATA_BOOLEAN_KEYS) {
		const field = input[key];
		if (field !== undefined) {
			if (typeof field !== "boolean") fail("INVALID_FRAME", "usage metadata flag must be boolean", `${path}.${key}`);
			output[key] = field;
		}
	}
	return output as UsageWireMetadata;
}

function decodeReport(value: unknown, path: string): UsageWireReport {
	const input = strictObject(value, path, ["provider", "fetchedAt", "limits", "resetCredits", "notes", "metadata"]);
	requiredFields(input, path, ["provider", "fetchedAt", "limits"]);
	const provider = controlFree(input.provider, `${path}.provider`, 128);
	const limits = boundedArray(input.limits, `${path}.limits`, USAGE_MAX_LIMITS_PER_REPORT).map((limit, index) =>
		decodeLimit(limit, `${path}.limits[${index}]`, provider),
	);
	const ids = new Set<string>();
	for (let index = 0; index < limits.length; index++) {
		const id = limits[index]!.id;
		if (ids.has(id)) fail("INVALID_FRAME", "duplicate usage limit id", `${path}.limits[${index}].id`);
		ids.add(id);
	}
	return {
		provider,
		fetchedAt: timestamp(input.fetchedAt, `${path}.fetchedAt`),
		limits,
		...(input.resetCredits === undefined
			? {}
			: { resetCredits: decodeResetCredits(input.resetCredits, `${path}.resetCredits`) }),
		...(input.notes === undefined
			? {}
			: { notes: displayNotes(input.notes, `${path}.notes`, USAGE_MAX_PROVIDER_NOTES) }),
		...(input.metadata === undefined ? {} : { metadata: decodeMetadata(input.metadata, `${path}.metadata`) }),
	};
}

function safeEnterpriseUrl(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	const text = controlFree(value, path, 2048);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		fail("INVALID_FRAME", "enterpriseUrl must be a valid URL", path);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	)
		fail("INVALID_FRAME", "enterpriseUrl must be an http(s) URL without credentials or parameters", path);
	return text;
}

function decodeAccountWithoutUsage(value: unknown, path: string): UsageWireAccountWithoutReport {
	const input = strictObject(value, path, [
		"provider",
		"type",
		"email",
		"accountId",
		"projectId",
		"enterpriseUrl",
		"orgId",
		"orgName",
	]);
	requiredFields(input, path, ["provider", "type"]);
	const optional = (key: string): string | undefined => optionalDisplayText(input[key], `${path}.${key}`, 512);
	const email = optional("email");
	const accountId = optional("accountId");
	const projectId = optional("projectId");
	const enterpriseUrl = safeEnterpriseUrl(input.enterpriseUrl, `${path}.enterpriseUrl`);
	const orgId = optional("orgId");
	const orgName = optional("orgName");
	return {
		provider: controlFree(input.provider, `${path}.provider`, 128),
		type: enumValue(input.type, `${path}.type`, USAGE_ACCOUNT_TYPES),
		...(email === undefined ? {} : { email }),
		...(accountId === undefined ? {} : { accountId }),
		...(projectId === undefined ? {} : { projectId }),
		...(enterpriseUrl === undefined ? {} : { enterpriseUrl }),
		...(orgId === undefined ? {} : { orgId }),
		...(orgName === undefined ? {} : { orgName }),
	};
}

function decodeCapacityWindow(value: unknown, path: string): UsageWireCapacityWindow {
	const input = strictObject(value, path, ["window", "durationMs", "accounts", "usedAccounts", "remainingAccounts"]);
	requiredFields(input, path, ["window", "accounts", "usedAccounts", "remainingAccounts"]);
	const accounts = count(input.accounts, `${path}.accounts`, USAGE_MAX_CAPACITY_ACCOUNTS);
	return {
		window: controlFree(input.window, `${path}.window`, 256),
		...(input.durationMs === undefined ? {} : { durationMs: duration(input.durationMs, `${path}.durationMs`) }),
		accounts,
		usedAccounts: boundedNumber(input.usedAccounts, `${path}.usedAccounts`, 0, accounts),
		remainingAccounts: boundedNumber(input.remainingAccounts, `${path}.remainingAccounts`, 0, accounts),
	};
}
function decodeCapacity(value: unknown, path: string): Record<string, UsageWireCapacityWindow[]> {
	const input = boundedMap(value, path, USAGE_MAX_CAPACITY_PROVIDERS);
	const output: Record<string, UsageWireCapacityWindow[]> = {};
	for (const [provider, windows] of Object.entries(input)) {
		controlFree(provider, `${path}.${provider}`, 128);
		output[provider] = boundedArray(windows, `${path}.${provider}`, USAGE_MAX_CAPACITY_WINDOWS).map((window, index) =>
			decodeCapacityWindow(window, `${path}.${provider}[${index}]`),
		);
	}
	return output;
}

export function decodeUsageReadResult(value: unknown): UsageReadResult {
	const input = strictObject(value, "result", ["generatedAt", "reports", "accountsWithoutUsage", "capacity"]);
	requiredFields(input, "result", ["generatedAt", "reports", "accountsWithoutUsage", "capacity"]);
	let encoded: string;
	try {
		encoded = JSON.stringify(input);
	} catch {
		fail("INVALID_FRAME", "usage result must be JSON serializable", "result");
	}
	if (utf8ByteLength(encoded) > USAGE_RESULT_MAX_BYTES)
		fail("BOUNDS", "usage result exceeds its wire budget", "result");
	const reports = boundedArray(input.reports, "result.reports", USAGE_MAX_REPORTS).map((report, index) =>
		decodeReport(report, `result.reports[${index}]`),
	);
	return {
		generatedAt: timestamp(input.generatedAt, "result.generatedAt"),
		reports,
		accountsWithoutUsage: boundedArray(
			input.accountsWithoutUsage,
			"result.accountsWithoutUsage",
			USAGE_MAX_ACCOUNTS_WITHOUT_REPORT,
		).map((account, index) => decodeAccountWithoutUsage(account, `result.accountsWithoutUsage[${index}]`)),
		capacity: decodeCapacity(input.capacity, "result.capacity"),
	};
}
