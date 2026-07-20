import { type ArtifactDescriptor, decodeArtifactDescriptor } from "./entry.js";
import { fail } from "./errors.js";
import { boundedArray, boundedMap, boundedText, controlFree, inputObject, safeRelativePath } from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId, type TurnId, turnId } from "./ids.js";
import { MAX_FILE_BYTES, MAX_TURN_FILE_CHANGES, PROTOCOL_VERSION } from "./limits.js";

export const TURN_FILE_CONTENT_KINDS = ["text", "binary", "huge", "missing"] as const;
export type TurnFileContentKind = (typeof TURN_FILE_CONTENT_KINDS)[number];
export const TURN_FILE_CHANGE_STATUSES = ["added", "modified", "deleted", "renamed", "copied", "untracked"] as const;
export type TurnFileChangeStatus = (typeof TURN_FILE_CHANGE_STATUSES)[number];
export const TURN_FILE_REVIEW_STATES = ["pending", "applied", "discarded"] as const;
export type TurnFileReviewState = (typeof TURN_FILE_REVIEW_STATES)[number];
export interface TurnFileChange {
	readonly path: string;
	readonly status: TurnFileChangeStatus;
	readonly kind: TurnFileContentKind;
	readonly state: TurnFileReviewState;
	readonly additions: number;
	readonly deletions: number;
	readonly size?: number;
	readonly previousPath?: string;
}
export interface TurnReviewSnapshot {
	readonly turnId: TurnId;
	readonly baseTree: string;
	readonly headTree: string;
	readonly changes: readonly TurnFileChange[];
	readonly patch?: ArtifactDescriptor;
}
export function decodeTurnReviewSnapshot(input: unknown, path = "turnReview"): TurnReviewSnapshot {
	const value = boundedMap(input, path);
	const allowed: Record<string, true> = { turnId: true, baseTree: true, headTree: true, changes: true, patch: true };
	for (const key of Object.keys(value))
		if (allowed[key] !== true) fail("INVALID_FRAME", "unknown turn review field", `${path}.${key}`);
	turnId(value.turnId, `${path}.turnId`);
	controlFree(value.baseTree, `${path}.baseTree`, 128);
	controlFree(value.headTree, `${path}.headTree`, 128);
	const changes = boundedArray(value.changes, `${path}.changes`, MAX_TURN_FILE_CHANGES).map((change, index) => {
		const item = boundedMap(change, `${path}.changes[${index}]`);
		const changeAllowed: Record<string, true> = {
			path: true,
			status: true,
			kind: true,
			state: true,
			additions: true,
			deletions: true,
			size: true,
			previousPath: true,
		};
		for (const key of Object.keys(item))
			if (changeAllowed[key] !== true)
				fail("INVALID_FRAME", "unknown turn file change field", `${path}.changes[${index}].${key}`);
		const status = controlFree(item.status, `${path}.changes[${index}].status`, 16);
		if (!(TURN_FILE_CHANGE_STATUSES as readonly string[]).includes(status))
			fail("INVALID_FRAME", "unsupported turn file change status", `${path}.changes[${index}].status`);
		const kind = controlFree(item.kind, `${path}.changes[${index}].kind`, 16);
		if (!(TURN_FILE_CONTENT_KINDS as readonly string[]).includes(kind))
			fail("INVALID_FRAME", "unsupported turn file content kind", `${path}.changes[${index}].kind`);
		const state = controlFree(item.state, `${path}.changes[${index}].state`, 16);
		if (!(TURN_FILE_REVIEW_STATES as readonly string[]).includes(state))
			fail("INVALID_FRAME", "unsupported turn file review state", `${path}.changes[${index}].state`);
		for (const [key, candidate] of [
			["additions", item.additions],
			["deletions", item.deletions],
		] as const)
			if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)
				fail(
					"INVALID_FRAME",
					`turn file ${key} must be a non-negative safe integer`,
					`${path}.changes[${index}].${key}`,
				);
		if (
			item.size !== undefined &&
			(typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0)
		)
			fail("INVALID_FRAME", "turn file size must be a non-negative safe integer", `${path}.changes[${index}].size`);
		if (item.previousPath !== undefined)
			safeRelativePath(item.previousPath, `${path}.changes[${index}].previousPath`);
		return {
			path: safeRelativePath(item.path, `${path}.changes[${index}].path`),
			status: status as TurnFileChangeStatus,
			kind: kind as TurnFileContentKind,
			state: state as TurnFileReviewState,
			additions: item.additions as number,
			deletions: item.deletions as number,
			...(item.size === undefined ? {} : { size: item.size as number }),
			...(item.previousPath === undefined ? {} : { previousPath: item.previousPath as string }),
		};
	});
	let patch: ArtifactDescriptor | undefined;
	if (value.patch !== undefined) {
		patch = decodeArtifactDescriptor(value.patch, `${path}.patch`);
		if (patch.kind !== "patch")
			fail("INVALID_FRAME", "turn review patch must be a patch artifact", `${path}.patch.kind`);
	}
	return {
		turnId: value.turnId as TurnId,
		baseTree: value.baseTree as string,
		headTree: value.headTree as string,
		changes,
		...(patch === undefined ? {} : { patch }),
	};
}

export interface FileFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	content?: string;
	truncated?: boolean;
}
export interface ReviewFrame {
	v: typeof PROTOCOL_VERSION;
	type: "review";
	hostId: HostId;
	sessionId: SessionId;
	reviewId: string;
	status: string;
	path?: string;
	findings: Record<string, unknown>[];
}
export function decodeFiles(input: unknown): FileFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "files") fail("INVALID_FRAME", "expected files frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	const path = safeRelativePath(frame.path);
	if (frame.content !== undefined) boundedText(frame.content, "content", MAX_FILE_BYTES);
	if (frame.truncated !== undefined && typeof frame.truncated !== "boolean")
		fail("INVALID_FRAME", "truncated must be boolean", "truncated");
	return { ...frame, path } as unknown as FileFrame;
}
export function decodeReview(input: unknown): ReviewFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "review") fail("INVALID_FRAME", "expected review frame", "type");
	hostId(frame.hostId);
	sessionId(frame.sessionId);
	controlFree(frame.reviewId, "reviewId", 256);
	controlFree(frame.status, "status", 64);
	if (frame.path !== undefined) safeRelativePath(frame.path, "path");
	const findings = boundedArray(frame.findings, "findings");
	for (let i = 0; i < findings.length; i++) boundedMap(findings[i], `findings[${i}]`);
	return frame as unknown as ReviewFrame;
}
