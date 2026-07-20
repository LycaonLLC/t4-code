import { describe, expect, test } from "bun:test";
import {
	AppWireError,
	COMMAND_DESCRIPTORS,
	decodeCommandArguments,
	decodeCommandResult,
	decodeServerFrame,
	REMOTE_DEFAULT_CAPABILITIES,
	USAGE_MAX_CAPACITY_ACCOUNTS,
	USAGE_MAX_LIMIT_NOTES,
	USAGE_MAX_REPORTS,
} from "../src/index.js";

const limit = {
	id: "five-hour",
	label: "5 Hour",
	scope: {
		provider: "anthropic",
		accountId: "account-1",
		orgId: "org-1",
		modelId: "claude-fable-5",
		tier: "fable",
		windowId: "5h",
		shared: true,
	},
	window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_800_000_000_000 },
	amount: { used: 45, limit: 100, remaining: 55, usedFraction: 0.45, remainingFraction: 0.55, unit: "percent" },
	status: "ok",
	notes: ["Includes all Claude models"],
};

const report = {
	provider: "anthropic",
	fetchedAt: 1_799_999_000_000,
	limits: [limit],
	resetCredits: {
		availableCount: 1,
		credits: [{ grantedAt: "2026-07-01T00:00:00Z", expiresAt: "2026-08-01T00:00:00Z", status: "available" }],
	},
	notes: ["Provider-reported quota"],
	metadata: {
		email: "user@example.com",
		accountId: "account-1",
		orgId: "org-1",
		orgName: "Research",
		planType: "Max",
		allowed: true,
		limitReached: false,
	},
};

const snapshot = {
	generatedAt: 1_799_999_100_000,
	reports: [report],
	accountsWithoutUsage: [
		{
			provider: "google-antigravity",
			type: "oauth",
			email: "other@example.com",
			projectId: "project-1",
			enterpriseUrl: "https://example.com/enterprise",
		},
	],
	capacity: {
		anthropic: [{ window: "5h", durationMs: 18_000_000, accounts: 1, usedAccounts: 0.45, remainingAccounts: 0.55 }],
	},
};

describe("usage.read wire contract", () => {
	test("is a strict host-scoped read capability with a typed result", () => {
		expect(COMMAND_DESCRIPTORS["usage.read"]).toEqual({
			capability: "usage.read",
			scope: "host",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
			desktopCatalog: true,
		});
		expect(REMOTE_DEFAULT_CAPABILITIES).not.toContain("usage.read");
		expect(decodeCommandArguments("usage.read", {})).toEqual({});
		expect(() => decodeCommandArguments("usage.read", { provider: "anthropic" })).toThrow(AppWireError);
		expect(decodeCommandResult("usage.read", snapshot)).toEqual(snapshot);

		const response = decodeServerFrame({
			v: "omp-app/1",
			type: "response",
			requestId: "request-1",
			commandId: "command-1",
			command: "usage.read",
			hostId: "host-1",
			ok: true,
			result: snapshot,
		});
		expect(response.type).toBe("response");
	});

	test("rejects provider raw payloads, secret metadata, and non-whitelisted metadata", () => {
		for (const malformed of [
			{ ...report, raw: { providerResponse: "large" } },
			{ ...report, metadata: { ...report.metadata, accessToken: "secret" } },
			{ ...report, metadata: { ...report.metadata, endpoint: "https://provider.example/usage" } },
			{ ...report, metadata: { ...report.metadata, allowed: "yes" } },
		])
			expect(() => decodeCommandResult("usage.read", { ...snapshot, reports: [malformed] })).toThrow(AppWireError);
	});

	test("enforces nested identity, provider, notes, and URL safety", () => {
		for (const malformed of [
			{ ...report, provider: "anthropic\nforged" },
			{ ...report, limits: [{ ...limit, scope: { ...limit.scope, provider: "openai-codex" } }] },
			{ ...report, limits: [{ ...limit, notes: Array(USAGE_MAX_LIMIT_NOTES + 1).fill("note") }] },
			{ ...report, limits: [{ ...limit, amount: { ...limit.amount, used: Number.POSITIVE_INFINITY } }] },
			{ ...report, limits: [{ ...limit, status: "blocked" }] },
		])
			expect(() => decodeCommandResult("usage.read", { ...snapshot, reports: [malformed] })).toThrow(AppWireError);

		expect(() =>
			decodeCommandResult("usage.read", {
				...snapshot,
				accountsWithoutUsage: [
					{ ...snapshot.accountsWithoutUsage[0], enterpriseUrl: "https://token@example.com/path?secret=value" },
				],
			}),
		).toThrow(AppWireError);
	});

	test("accepts fractional capacity across multiple accounts and enforces aggregate account bounds", () => {
		const valid = {
			...snapshot,
			capacity: {
				anthropic: [{ window: "5h", accounts: 2, usedAccounts: 0.8, remainingAccounts: 1.2 }],
			},
		};
		expect(decodeCommandResult("usage.read", valid)).toEqual(valid);
		for (const malformed of [
			{ window: "5h", accounts: USAGE_MAX_CAPACITY_ACCOUNTS + 1, usedAccounts: 0, remainingAccounts: 0 },
			{ window: "5h", accounts: 2, usedAccounts: 2.1, remainingAccounts: 0 },
			{ window: "5h", accounts: 2, usedAccounts: 0, remainingAccounts: 2.1 },
		])
			expect(() =>
				decodeCommandResult("usage.read", {
					...snapshot,
					capacity: { anthropic: [malformed] },
				}),
			).toThrow(AppWireError);
	});

	test("rejects reset-credit timestamps that consumers cannot parse", () => {
		expect(() =>
			decodeCommandResult("usage.read", {
				...snapshot,
				reports: [
					{
						...report,
						resetCredits: {
							availableCount: 1,
							credits: [{ grantedAt: "not-a-date", status: "available" }],
						},
					},
				],
			}),
		).toThrow(AppWireError);
	});

	test("bounds report count and the aggregate response below the protocol frame ceiling", () => {
		expect(() =>
			decodeCommandResult("usage.read", {
				...snapshot,
				reports: Array.from({ length: USAGE_MAX_REPORTS + 1 }, () => report),
			}),
		).toThrow(AppWireError);

		const oversizedReport = {
			...report,
			limits: [],
			notes: Array.from({ length: 8 }, () => "x".repeat(1024)),
		};
		expect(() =>
			decodeCommandResult("usage.read", {
				...snapshot,
				reports: Array.from({ length: USAGE_MAX_REPORTS }, () => oversizedReport),
				accountsWithoutUsage: [],
				capacity: {},
			}),
		).toThrow(AppWireError);
	});
});
