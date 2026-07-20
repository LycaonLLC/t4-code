import type { Cursor, ServerFrame } from "@t4-code/host-wire";
import type { SessionProjection } from "./projection.ts";
import type { SubagentProjection } from "./subagent-projection.ts";
import type { PreparedAttachOutput } from "./types.ts";

export function prepareAttachOutput(projection: SessionProjection, cursor?: Cursor): PreparedAttachOutput {
	const initialFrames = cursor === undefined ? [projection.snapshot()] : projection.replay(cursor);
	return { initialFrames, baseline: { ...projection.value.cursor } };
}

export function completeAttachOutput(
	prepared: PreparedAttachOutput,
	projection: SessionProjection,
	subagents?: SubagentProjection,
): ServerFrame[] {
	return [...prepared.initialFrames, ...projection.replay(prepared.baseline), ...(subagents?.frames() ?? [])];
}
