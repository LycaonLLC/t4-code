import { describe, expect, test } from "bun:test";
import {
	AppWireError,
	COMMAND_DESCRIPTORS,
	decodeBrokerStatusResult,
	decodeCommandArguments,
	decodeCommandResult,
	REMOTE_DEFAULT_CAPABILITIES,
} from "../src/index.js";

describe("broker.status wire contract", () => {
	test("is a strict host-scoped redacted read capability", () => {
		expect(COMMAND_DESCRIPTORS["broker.status"]).toEqual({
			capability: "broker.read",
			scope: "host",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
			desktopCatalog: true,
		});
		expect(REMOTE_DEFAULT_CAPABILITIES).not.toContain("broker.read");
		expect(decodeCommandArguments("broker.status", {})).toEqual({});
		expect(() => decodeCommandArguments("broker.status", { token: "secret" })).toThrow(AppWireError);
	});

	test("accepts only the bounded redacted status variants", () => {
		for (const status of [
			{ state: "local", generation: 0 },
			{ state: "connected", endpoint: "https://broker.example/", generation: 7 },
			{ state: "missing-token", generation: 2 },
			{ state: "missing-token", endpoint: "http://broker.internal:8765/", generation: 2 },
			{ state: "unreachable", endpoint: "https://broker.example/", generation: 3 },
		]) {
			expect(decodeBrokerStatusResult(status)).toEqual(status);
			expect(decodeCommandResult("broker.status", status)).toEqual(status);
		}
	});

	test("rejects secret-bearing, ambiguous, and malformed status data", () => {
		for (const malformed of [
			{ state: "connected", endpoint: "https://user:secret@broker.example/", generation: 1 },
			{ state: "connected", endpoint: "https://broker.example/?token=secret", generation: 1 },
			{ state: "connected", endpoint: "https://broker.example/#secret", generation: 1 },
			{ state: "connected", endpoint: "file:///tmp/broker", generation: 1 },
			{ state: "connected", generation: 1 },
			{ state: "local", endpoint: "https://broker.example/", generation: 1 },
			{ state: "unreachable", endpoint: "https://broker.example/", generation: -1 },
			{ state: "local", generation: 1.5 },
			{ state: "local", generation: 2_147_483_648 },
			{ state: "other", generation: 1 },
			{ state: "local", generation: 1, token: "secret" },
		]) {
			expect(() => decodeBrokerStatusResult(malformed)).toThrow(AppWireError);
		}
	});
});
