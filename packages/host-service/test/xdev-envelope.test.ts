import { describe, expect, test } from "bun:test";
import { xdevExecutionMatches, xdevResultEnvelope, xdevWriteCall } from "../src/xdev-envelope.ts";

describe("xdev execution envelopes", () => {
	test.each([
		["resolve", " Apply the preview. ", { reason: "Apply the preview." }],
		["reject", " Discard this change. ", { reason: "Discard this change." }],
		["propose", " session-lifecycle-plan ", { title: "session-lifecycle-plan" }],
		["report_issue", " write: lost the final line ", { report: "write: lost the final line" }],
	] as const)("normalizes the plain-text xd://%s device", (tool, content, args) => {
		expect(xdevWriteCall("write", { path: `xd://${tool}`, content })).toEqual({ tool, args });
	});

	test("keeps JSON devices strict while preserving executable result metadata", () => {
		expect(xdevWriteCall("write", { path: "xd://hub", content: "not-json" })).toBeUndefined();
		expect(xdevWriteCall("write", { path: "xd://hub", content: '{"op":"list"}' })).toEqual({
			tool: "hub",
			args: { op: "list" },
		});
		expect(
			xdevResultEnvelope({
				xdev: {
					tool: "resolve",
					mode: "execute",
					args: { reason: "Apply the preview." },
					inner: { action: "apply" },
				},
			}),
		).toEqual({
			tool: "resolve",
			mode: "execute",
			args: { reason: "Apply the preview." },
			inner: { action: "apply" },
		});
	});

	test("rejects non-write, malformed, oversized, and case-spoofed plain-text calls", () => {
		expect(xdevWriteCall("read", { path: "xd://resolve", content: "Apply" })).toBeUndefined();
		expect(xdevWriteCall("write", { path: "xd://Resolve", content: "Apply" })).toBeUndefined();
		expect(xdevWriteCall("write", { path: "xd://resolve", content: "x".repeat(128 * 1024 + 1) })).toBeUndefined();
		expect(xdevWriteCall("write", { path: "xd://resolve/extra", content: "Apply" })).toBeUndefined();
	});

	test("requires supplied arguments to match while permitting JSON schema defaults", () => {
		const call = xdevWriteCall("write", { path: "xd://resolve", content: "Apply A" });
		expect(
			xdevExecutionMatches(call, {
				tool: "resolve",
				mode: "execute",
				args: { reason: "Apply A" },
				inner: {},
			}),
		).toBe(true);
		expect(
			xdevExecutionMatches(call, {
				tool: "resolve",
				mode: "execute",
				args: { reason: "Apply B" },
				inner: {},
			}),
		).toBe(false);
		expect(
			xdevExecutionMatches(call, {
				tool: "resolve",
				mode: "execute",
				args: { reason: "Apply A", extra: true },
				inner: {},
			}),
		).toBe(false);
		expect(
			xdevExecutionMatches(
				xdevWriteCall("write", {
					path: "xd://hub",
					content: '{"op":"send","to":"reviewer","options":{"priority":"high"},"tags":["one"]}',
				}),
				{
					tool: "hub",
					mode: "execute",
					args: {
						op: "send",
						to: "reviewer",
						options: { priority: "high", retries: 1 },
						tags: ["one"],
						defaulted: true,
					},
					inner: {},
				},
			),
		).toBe(true);
		expect(
			xdevExecutionMatches(
				xdevWriteCall("write", {
					path: "xd://hub",
					content: '{"op":"send","options":{"priority":"high"}}',
				}),
				{
					tool: "hub",
					mode: "execute",
					args: { op: "send", options: { priority: "low", retries: 1 } },
					inner: {},
				},
			),
		).toBe(false);
		expect(
			xdevExecutionMatches(xdevWriteCall("write", { path: "xd://hub", content: '{"op":"send","to":"reviewer"}' }), {
				tool: "hub",
				mode: "execute",
				args: { op: "delete", to: "victim" },
				inner: {},
			}),
		).toBe(false);
		expect(
			xdevExecutionMatches(xdevWriteCall("write", { path: "xd://hub", content: '{"op":"send","to":"reviewer"}' }), {
				tool: "hub",
				mode: "execute",
				args: { op: "send" },
				inner: {},
			}),
		).toBe(false);
	});
});
