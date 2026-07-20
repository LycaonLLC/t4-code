import { describe, expect, it } from "vite-plus/test";

import {
  decodeArtifactDescriptor,
  INVALID_TRANSCRIPT_ARTIFACT_METADATA,
  transcriptArtifactsFromEntry,
} from "../src/features/transcript/artifact-metadata.ts";
import {
  createTranscriptArtifactSource,
  decodeTranscriptArtifactChunk,
  type TranscriptArtifactSource,
} from "../src/features/session-runtime/transcript-images.ts";

const descriptor = {
  artifactId: "artifact-1",
  kind: "image" as const,
  mediaType: "image/png",
  disposition: "inline" as const,
  retention: "session" as const,
};
const artifact = { ...descriptor, source: "artifact" as const };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64 = btoa(String.fromCharCode(...png));

function chunk(offset = 0) {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    size: png.byteLength,
    offset,
    nextOffset: png.byteLength,
    complete: true,
    content: base64,
  };
}

async function ready(source: TranscriptArtifactSource): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("artifact did not load")), 1_000);
    const unsubscribe = source.subscribe(artifact, () => {
      if (source.getSnapshot(artifact).status === "ready") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("transcript artifact metadata", () => {
  it("rejects descriptors with unknown fields and never partially trusts a list", () => {
    expect(decodeArtifactDescriptor(descriptor)).toMatchObject({ artifactId: "artifact-1" });
    expect(() => decodeArtifactDescriptor({ ...descriptor, path: "/tmp/no" })).toThrow(
      INVALID_TRANSCRIPT_ARTIFACT_METADATA,
    );
    expect(
      transcriptArtifactsFromEntry({
        id: "entry",
        data: { artifacts: [descriptor, { ...descriptor, artifactId: "" }] },
      } as never),
    ).toEqual({ artifacts: [], issue: INVALID_TRANSCRIPT_ARTIFACT_METADATA });
  });

  it("strictly validates chunk identity, ordering, and byte length", () => {
    expect(decodeTranscriptArtifactChunk(chunk(), artifact, 0)).toMatchObject({
      kind: "image",
      complete: true,
    });
    expect(() =>
      decodeTranscriptArtifactChunk({ ...chunk(), artifactId: "other" }, artifact, 0),
    ).toThrow();
    expect(() => decodeTranscriptArtifactChunk({ ...chunk(), offset: 1 }, artifact, 0)).toThrow();
    expect(() =>
      decodeTranscriptArtifactChunk({ ...chunk(), content: "AQ==" }, artifact, 0),
    ).toThrow();
  });

  it("does not read until explicitly retained and keeps object URLs outside projections", async () => {
    let reads = 0;
    const source = createTranscriptArtifactSource({
      availability: { available: true },
      readChunk: async () => {
        reads += 1;
        return { accepted: true, result: chunk() };
      },
      createObjectUrl: () => "blob:artifact-test",
      revokeObjectUrl: () => undefined,
      digest: async () => "",
    });
    expect(source.getSnapshot(artifact)).toEqual({ status: "loading" });
    expect(reads).toBe(0);
    const release = source.retain(artifact);
    await ready(source);
    expect(source.getSnapshot(artifact)).toMatchObject({
      status: "ready",
      url: "blob:artifact-test",
    });
    release();
    source.dispose();
  });
});
