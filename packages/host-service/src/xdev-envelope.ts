const XD_URL_PREFIX = "xd://";
const MAX_XDEV_CONTENT_BYTES = 128 * 1024;
const MAX_XDEV_TOOL_BYTES = 256;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function xdevToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	if (!name || /[/?#]/u.test(name) || encoder.encode(name).byteLength > MAX_XDEV_TOOL_BYTES) return undefined;
	return name;
}

function xdevTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const path = value.trim();
	if (!path.toLowerCase().startsWith(XD_URL_PREFIX)) return undefined;
	return xdevToolName(path.slice(XD_URL_PREFIX.length));
}

function plainTextXdevArgs(tool: string, content: string): Record<string, unknown> | undefined {
	const text = content.trim();
	switch (tool) {
		case "resolve":
		case "reject":
			return { reason: text };
		case "propose":
			return { title: text };
		case "report_issue":
			return { report: text };
		default:
			return undefined;
	}
}

function plainTextArgKey(tool: string): "reason" | "title" | "report" | undefined {
	switch (tool) {
		case "resolve":
		case "reject":
			return "reason";
		case "propose":
			return "title";
		case "report_issue":
			return "report";
		default:
			return undefined;
	}
}

function jsonSubsetMatches(expected: unknown, actual: unknown): boolean {
	const pending: Array<{ expected: unknown; actual: unknown }> = [{ expected, actual }];
	while (pending.length > 0) {
		const pair = pending.pop();
		if (!pair) continue;
		if (Array.isArray(pair.expected)) {
			if (!Array.isArray(pair.actual) || pair.expected.length !== pair.actual.length) return false;
			for (let index = 0; index < pair.expected.length; index++) {
				pending.push({ expected: pair.expected[index], actual: pair.actual[index] });
			}
			continue;
		}
		if (isRecord(pair.expected)) {
			if (!isRecord(pair.actual)) return false;
			for (const [key, value] of Object.entries(pair.expected)) {
				if (!Object.hasOwn(pair.actual, key)) return false;
				pending.push({ expected: value, actual: pair.actual[key] });
			}
			continue;
		}
		if (pair.expected !== pair.actual) return false;
	}
	return true;
}

export interface XdevWriteCall {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Recognize a real v17 device dispatch from the outer write call. Invalid JSON,
 * help requests, and ordinary writes deliberately stay on the write path.
 */
export function xdevWriteCall(tool: unknown, value: unknown): XdevWriteCall | undefined {
	if (typeof tool !== "string" || tool.trim().toLowerCase() !== "write" || !isRecord(value)) return undefined;
	const target = xdevTarget(value.path);
	if (!target || typeof value.content !== "string") return undefined;
	if (encoder.encode(value.content).byteLength > MAX_XDEV_CONTENT_BYTES) return undefined;
	const plainTextArgs = plainTextXdevArgs(target, value.content);
	if (plainTextArgs) return { tool: target, args: plainTextArgs };
	try {
		const args: unknown = JSON.parse(value.content);
		return isRecord(args) ? { tool: target, args } : undefined;
	} catch {
		return undefined;
	}
}

export interface XdevResultEnvelope {
	tool: string;
	mode: "execute";
	args: Record<string, unknown>;
	inner: unknown;
}

/**
 * Correlate an executable result to its original device write. JSON devices
 * may add schema-defaulted object keys, but every supplied value must remain
 * deeply equal. The four plain-text devices are deterministic: their one
 * derived argument must match exactly before semantic promotion.
 */
export function xdevExecutionMatches(
	call: Pick<XdevWriteCall, "tool" | "args"> | undefined,
	result: XdevResultEnvelope | undefined,
): boolean {
	if (!call || !result || call.tool !== result.tool) return false;
	const key = plainTextArgKey(call.tool);
	if (!key) return jsonSubsetMatches(call.args, result.args);
	const callKeys = Object.keys(call.args);
	const resultKeys = Object.keys(result.args);
	return (
		callKeys.length === 1 &&
		callKeys[0] === key &&
		resultKeys.length === 1 &&
		resultKeys[0] === key &&
		typeof call.args[key] === "string" &&
		call.args[key] === result.args[key]
	);
}

/** Parse only executable v17 envelopes. Help/documentation writes remain write results. */
export function xdevResultEnvelope(value: unknown): XdevResultEnvelope | undefined {
	if (!isRecord(value) || !isRecord(value.xdev)) return undefined;
	const xdev = value.xdev;
	const tool = xdevToolName(xdev.tool);
	if (!tool || xdev.mode !== "execute" || !isRecord(xdev.args)) return undefined;
	return { tool, mode: "execute", args: xdev.args, inner: xdev.inner };
}
