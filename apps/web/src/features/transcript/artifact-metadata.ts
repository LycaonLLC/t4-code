// Durable artifact metadata remains inert in transcript projections. Renderer bytes
// are fetched lazily through artifact.read and never retained in rows or stores.
import type { DurableEntry } from "./projection.ts";

export const TRANSCRIPT_ARTIFACT_MAX_COUNT = 64;
export const TRANSCRIPT_ARTIFACT_MAX_SIZE = 20 * 1024 * 1024;

export type ArtifactKind = "image" | "text" | "patch" | "binary";
export type ArtifactDisposition = "inline" | "attachment";

export interface ArtifactDescriptorReference {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly disposition: ArtifactDisposition;
  readonly retention: "session";
  readonly size?: number | undefined;
  readonly sha256?: string | undefined;
  readonly name?: string | undefined;
}

export interface TranscriptArtifactReference extends ArtifactDescriptorReference {
  readonly source: "artifact";
}

export interface TranscriptArtifactMetadataResult {
  readonly artifacts: readonly TranscriptArtifactReference[];
  readonly issue: string | null;
}

export const INVALID_TRANSCRIPT_ARTIFACT_METADATA =
  "This transcript entry contains invalid artifact metadata.";

const EMPTY_RESULT: TranscriptArtifactMetadataResult = Object.freeze({
  artifacts: Object.freeze([]),
  issue: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * Local strict boundary for the additive descriptor. It intentionally accepts
 * no extension fields: transcript metadata is an authorization input for a
 * renderer read, not a display hint.
 */
export function decodeArtifactDescriptor(value: unknown): ArtifactDescriptorReference {
  if (!isRecord(value)) throw new Error(INVALID_TRANSCRIPT_ARTIFACT_METADATA);
  const optional = ["size", "sha256", "name"].filter((key) => value[key] !== undefined);
  const expected = ["artifactId", "kind", "mediaType", "disposition", "retention", ...optional];
  const size = value.size;
  const sha256 = value.sha256;
  const name = value.name;
  if (
    !exactKeys(value, expected) ||
    !boundedString(value.artifactId, 512) ||
    !["image", "text", "patch", "binary"].includes(String(value.kind)) ||
    !boundedString(value.mediaType, 255) ||
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(
      value.mediaType,
    ) ||
    !["inline", "attachment"].includes(String(value.disposition)) ||
    value.retention !== "session" ||
    (size !== undefined &&
      (typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > TRANSCRIPT_ARTIFACT_MAX_SIZE)) ||
    (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256))) ||
    (name !== undefined && !boundedString(name, 512))
  ) {
    throw new Error(INVALID_TRANSCRIPT_ARTIFACT_METADATA);
  }
  return {
    artifactId: value.artifactId,
    kind: value.kind as ArtifactKind,
    mediaType: value.mediaType,
    disposition: value.disposition as ArtifactDisposition,
    retention: "session",
    ...(size === undefined ? {} : { size }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(name === undefined ? {} : { name }),
  };
}

/** Strictly adapts data.artifacts, rejecting the complete list on one bad item. */
export function transcriptArtifactsFromEntry(
  entry: DurableEntry,
): TranscriptArtifactMetadataResult {
  const raw = entry.data.artifacts;
  if (raw === undefined) return EMPTY_RESULT;
  if (!Array.isArray(raw) || raw.length > TRANSCRIPT_ARTIFACT_MAX_COUNT) {
    return { artifacts: [], issue: INVALID_TRANSCRIPT_ARTIFACT_METADATA };
  }
  try {
    return {
      artifacts: raw.map((item) => ({
        ...decodeArtifactDescriptor(item),
        source: "artifact" as const,
      })),
      issue: null,
    };
  } catch {
    return { artifacts: [], issue: INVALID_TRANSCRIPT_ARTIFACT_METADATA };
  }
}
