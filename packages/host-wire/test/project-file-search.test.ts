import { describe, expect, test } from "bun:test";
import {
	ADDITIVE_FEATURES,
	AppWireError,
	COMMAND_DESCRIPTORS,
	decodeCommandArguments,
	decodeCommandResult,
	PROJECT_FILE_SEARCH_MAX_QUERY_BYTES,
	PROJECT_FILE_SEARCH_MAX_RESULTS,
	PROTOCOL_FEATURES,
} from "../src/index.ts";

describe("project file search wire contract", () => {
	test("is an additive, session-scoped read using the existing file-list permission", () => {
		expect(PROTOCOL_FEATURES).toContain("files.search");
		expect(ADDITIVE_FEATURES).toContain("files.search");
		expect(COMMAND_DESCRIPTORS["files.search"]).toEqual({
			capability: "files.list",
			scope: "session",
			revision: "optional",
			revisionOwner: "authority",
			confirmation: "none",
		});
	});

	test("accepts only a bounded query and result limit", () => {
		expect(decodeCommandArguments("files.search", { query: "  app  ", limit: 8 })).toEqual({
			query: "app",
			limit: 8,
		});
		for (const value of [
			{ query: "" },
			{ query: "\u0000" },
			{ query: "x".repeat(PROJECT_FILE_SEARCH_MAX_QUERY_BYTES + 1) },
			{ query: "app", limit: 0 },
			{ query: "app", limit: PROJECT_FILE_SEARCH_MAX_RESULTS + 1 },
			{ query: "app", root: "/tmp/project" },
		])
			expect(() => decodeCommandArguments("files.search", value)).toThrow(AppWireError);
	});

	test("accepts only unique safe relative file paths", () => {
		expect(
			decodeCommandResult("files.search", {
				matches: [{ path: "src/app.ts" }, { path: ".github/workflows/check.yml" }],
				truncated: false,
			}),
		).toEqual({
			matches: [{ path: "src/app.ts" }, { path: ".github/workflows/check.yml" }],
			truncated: false,
		});
		for (const value of [
			{ matches: [{ path: "../secret" }], truncated: false },
			{ matches: [{ path: "/tmp/secret" }], truncated: false },
			{ matches: [{ path: "src/app.ts" }, { path: "src/app.ts" }], truncated: false },
			{ matches: [], truncated: "no" },
			{ matches: [], truncated: false, root: "/tmp/project" },
		])
			expect(() => decodeCommandResult("files.search", value)).toThrow(AppWireError);
	});
});
