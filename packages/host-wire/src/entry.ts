import { fail } from "./errors.js";
import { decodeTurnReviewSnapshot } from "./files-review.js";
import { boundedArray, boundedMap, controlFree, inputObject } from "./guards.js";
import {
	type ArtifactId,
	artifactId,
	type EntryId,
	entryId,
	type HostId,
	hostId,
	type SessionId,
	sessionId,
	type TurnId,
	turnId,
} from "./ids.js";
import { ARTIFACT_MAX_BYTES, MAX_ARTIFACTS_PER_ENTRY, TRANSCRIPT_IMAGE_MAX_COUNT } from "./limits.js";

export const TRANSCRIPT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type TranscriptImageMimeType = (typeof TRANSCRIPT_IMAGE_MIME_TYPES)[number];
export interface TranscriptImageMetadata {
	readonly sha256: string;
	readonly mimeType: TranscriptImageMimeType;
}

export function decodeTranscriptImageMetadata(input: unknown, path: string): TranscriptImageMetadata {
	const value = boundedMap(input, path);
	if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "sha256") || !Object.hasOwn(value, "mimeType"))
		fail("INVALID_FRAME", "transcript image metadata must contain only sha256 and mimeType", path);
	const sha256 = controlFree(value.sha256, `${path}.sha256`, 64);
	if (!/^[a-f0-9]{64}$/u.test(sha256))
		fail("INVALID_FRAME", "transcript image sha256 must be lowercase hexadecimal", `${path}.sha256`);
	const mimeType = controlFree(value.mimeType, `${path}.mimeType`, 32);
	if (!(TRANSCRIPT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType))
		fail("INVALID_FRAME", "unsupported transcript image MIME type", `${path}.mimeType`);
	return { sha256, mimeType: mimeType as TranscriptImageMimeType };
}

export function decodeTranscriptImageMetadataList(input: unknown, path: string): TranscriptImageMetadata[] {
	return boundedArray(input, path, TRANSCRIPT_IMAGE_MAX_COUNT).map((value, index) =>
		decodeTranscriptImageMetadata(value, `${path}[${index}]`),
	);
}
export const ARTIFACT_KINDS = ["image", "text", "patch", "binary"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ARTIFACT_DISPOSITIONS = ["inline", "attachment"] as const;
export type ArtifactDisposition = (typeof ARTIFACT_DISPOSITIONS)[number];
export interface ArtifactDescriptor {
	readonly artifactId: ArtifactId;
	readonly kind: ArtifactKind;
	readonly mediaType: string;
	readonly size?: number;
	readonly sha256?: string;
	readonly name?: string;
	readonly disposition: ArtifactDisposition;
	readonly retention: "session";
}
export function decodeArtifactDescriptor(input: unknown, path: string): ArtifactDescriptor {
	const value = boundedMap(input, path);
	const allowed: Record<string, true> = {
		artifactId: true,
		kind: true,
		mediaType: true,
		size: true,
		sha256: true,
		name: true,
		disposition: true,
		retention: true,
	};
	for (const key of Object.keys(value))
		if (allowed[key] !== true) fail("INVALID_FRAME", "unknown artifact descriptor field", `${path}.${key}`);
	artifactId(value.artifactId, `${path}.artifactId`);
	const kind = controlFree(value.kind, `${path}.kind`, 16);
	if (!(ARTIFACT_KINDS as readonly string[]).includes(kind))
		fail("INVALID_FRAME", "unsupported artifact kind", `${path}.kind`);
	const mediaType = controlFree(value.mediaType, `${path}.mediaType`, 128);
	if (!/^[A-Za-z0-9!#$&^_.+*-]+\/[A-Za-z0-9!#$&^_.+*-]+$/u.test(mediaType))
		fail("INVALID_FRAME", "artifact mediaType must be a MIME type", `${path}.mediaType`);
	if (
		value.size !== undefined &&
		(typeof value.size !== "number" ||
			!Number.isSafeInteger(value.size) ||
			value.size < 0 ||
			value.size > ARTIFACT_MAX_BYTES)
	)
		fail("INVALID_FRAME", "artifact size must be a bounded non-negative safe integer", `${path}.size`);
	if (value.sha256 !== undefined) {
		const sha256 = controlFree(value.sha256, `${path}.sha256`, 64);
		if (!/^[a-f0-9]{64}$/u.test(sha256))
			fail("INVALID_FRAME", "artifact sha256 must be lowercase hexadecimal", `${path}.sha256`);
	}
	if (value.name !== undefined) controlFree(value.name, `${path}.name`, 512);
	const disposition = controlFree(value.disposition, `${path}.disposition`, 16);
	if (!(ARTIFACT_DISPOSITIONS as readonly string[]).includes(disposition))
		fail("INVALID_FRAME", "unsupported artifact disposition", `${path}.disposition`);
	if (value.retention !== "session") fail("INVALID_FRAME", "artifact retention must be session", `${path}.retention`);
	return value as unknown as ArtifactDescriptor;
}
export function decodeArtifactDescriptorList(input: unknown, path: string): ArtifactDescriptor[] {
	return boundedArray(input, path, MAX_ARTIFACTS_PER_ENTRY).map((value, index) =>
		decodeArtifactDescriptor(value, `${path}[${index}]`),
	);
}
export interface DurableEntry {
	id: EntryId;
	parentId: EntryId | null;
	hostId: HostId;
	sessionId: SessionId;
	turnId?: TurnId;
	kind: string;
	timestamp: string;
	data: Record<string, unknown>;
}
export function decodeEntry(input: unknown): DurableEntry {
	const path = "entry";
	const value = inputObject(input);
	entryId(value.id, `${path}.id`);
	if (value.parentId === undefined) fail("INVALID_FRAME", "parentId is required", `${path}.parentId`);
	if (value.parentId !== null) entryId(value.parentId, `${path}.parentId`);
	hostId(value.hostId, `${path}.hostId`);
	sessionId(value.sessionId, `${path}.sessionId`);
	controlFree(value.kind, `${path}.kind`, 128);
	controlFree(value.timestamp, `${path}.timestamp`, 128);
	const data = boundedMap(value.data, `${path}.data`);
	if (data.images !== undefined) decodeTranscriptImageMetadataList(data.images, `${path}.data.images`);
	if (value.turnId !== undefined) turnId(value.turnId, `${path}.turnId`);
	if (value.kind === "turn-review") {
		if (value.turnId === undefined) fail("INVALID_FRAME", "turn review requires turnId", `${path}.turnId`);
		const allowed: Record<string, true> = {
			baseTree: true,
			headTree: true,
			changes: true,
			patch: true,
			artifacts: true,
		};
		for (const key of Object.keys(data))
			if (allowed[key] !== true) fail("INVALID_FRAME", "unknown turn review data field", `${path}.data.${key}`);
		if (data.artifacts === undefined)
			fail("INVALID_FRAME", "turn review requires an artifacts list", `${path}.data.artifacts`);
		const artifacts = decodeArtifactDescriptorList(data.artifacts, `${path}.data.artifacts`);
		const review = decodeTurnReviewSnapshot(
			{
				turnId: value.turnId,
				baseTree: data.baseTree,
				headTree: data.headTree,
				changes: data.changes,
				patch: data.patch,
			},
			`${path}.data`,
		);
		if (
			review.patch === undefined
				? artifacts.length !== 0
				: artifacts.length !== 1 || artifacts[0]?.artifactId !== review.patch.artifactId
		)
			fail("INVALID_FRAME", "turn review artifacts must contain exactly its patch", `${path}.data.artifacts`);
	} else if (data.artifacts !== undefined) decodeArtifactDescriptorList(data.artifacts, `${path}.data.artifacts`);
	return value as unknown as DurableEntry;
}
export function isDurableEntry(value: unknown): value is DurableEntry {
	try {
		decodeEntry(value);
		return true;
	} catch {
		return false;
	}
}
