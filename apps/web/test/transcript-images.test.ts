import { createDesktopRuntimeController } from "@t4-code/client";
import {
  entryId,
  hostId,
  revision,
  sessionId,
  type DurableEntry,
  type SessionSnapshotFrame,
} from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureSessionRuntime } from "../src/features/session-runtime/controller.ts";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import {
  createTranscriptImageSource,
  decodeTranscriptImageChunk,
  disposeTranscriptImagesForSession,
  TRANSCRIPT_IMAGE_CACHE_ERROR,
  TRANSCRIPT_IMAGE_CHUNK_BYTES,
  TRANSCRIPT_IMAGE_DECODE_ERROR,
  TRANSCRIPT_IMAGE_INTEGRITY_ERROR,
  TRANSCRIPT_IMAGE_MAX_CHUNKS,
  TRANSCRIPT_IMAGE_PROTOCOL_ERROR,
  type TranscriptImageCommandResult,
  type TranscriptImageSnapshot,
  type TranscriptImageSource,
} from "../src/features/session-runtime/transcript-images.ts";
import {
  INVALID_TRANSCRIPT_IMAGE_METADATA,
  transcriptImagesFromEntry,
  type TranscriptImageMimeType,
  type TranscriptImageReference,
} from "../src/features/transcript/image-metadata.ts";
import { initialProjection, reduceTranscript } from "../src/features/transcript/projection.ts";
import { deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";

const HOST = "image-host";
const SESSION = "image-session";

function pngBytes(size = 16, salt = 0): Uint8Array {
  const bytes = new Uint8Array(Math.max(8, size));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = (index + salt) % 251;
  return bytes;
}

function gifBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x02]);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

async function reference(
  bytes: Uint8Array,
  options: { readonly entryId?: string; readonly mimeType?: TranscriptImageMimeType } = {},
): Promise<TranscriptImageReference> {
  return {
    entryId: options.entryId ?? "entry-image",
    sha256: await sha256(bytes),
    mimeType: options.mimeType ?? "image/png",
  };
}

function responseFor(
  bytes: Uint8Array,
  image: TranscriptImageReference,
  offset: number,
): TranscriptImageCommandResult {
  const nextOffset = Math.min(offset + TRANSCRIPT_IMAGE_CHUNK_BYTES, bytes.byteLength);
  return {
    accepted: true,
    result: {
      sha256: image.sha256,
      mimeType: image.mimeType,
      size: bytes.byteLength,
      offset,
      nextOffset,
      complete: nextOffset === bytes.byteLength,
      content: base64(bytes.subarray(offset, nextOffset)),
    },
  };
}

async function waitForStatus(
  source: TranscriptImageSource,
  image: TranscriptImageReference,
  status: TranscriptImageSnapshot["status"],
): Promise<TranscriptImageSnapshot> {
  const initial = source.getSnapshot(image);
  if (initial.status === status) return initial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for transcript image ${status}`));
    }, 2_000);
    const check = () => {
      const snapshot = source.getSnapshot(image);
      if (snapshot.status !== status) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = source.subscribe(image, check);
    check();
  });
}

function durableEntry(
  id: string,
  kind: string,
  data: Record<string, unknown>,
): DurableEntry {
  return {
    id: entryId(id),
    parentId: null,
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    kind,
    timestamp: "2026-07-14T12:00:00.000Z",
    data,
  };
}

describe("transcript image metadata", () => {
  it("preserves exact ordered metadata for message and tool-result rows", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    const message = durableEntry("message-images", "message", {
      role: "user",
      text: "look",
      images: [
        { sha256: first, mimeType: "image/png" },
        { sha256: second, mimeType: "image/webp" },
      ],
    });
    const tool = durableEntry("tool-images", "tool-result", {
      tool: "read",
      title: "read image",
      result: {},
      images: [{ sha256: second, mimeType: "image/webp" }],
    });
    const frame: SessionSnapshotFrame = {
      v: "omp-app/1",
      type: "snapshot",
      cursor: { epoch: "images", seq: 1 },
      revision: revision("images-revision"),
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      entries: [message, tool],
    };
    const rows = deriveTranscriptRows(reduceTranscript(initialProjection(), frame));
    const messageRow = rows.find((row) => row.kind === "message");
    const toolRow = rows.find((row) => row.kind === "tool-group");

    expect(messageRow?.kind === "message" && messageRow.images).toEqual([
      { entryId: "message-images", sha256: first, mimeType: "image/png" },
      { entryId: "message-images", sha256: second, mimeType: "image/webp" },
    ]);
    expect(toolRow?.kind === "tool-group" && toolRow.calls[0]?.images).toEqual([
      { entryId: "tool-images", sha256: second, mimeType: "image/webp" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("content");
  });

  it("rejects the whole metadata list when any item is malformed", () => {
    for (const images of [
      "not-an-array",
      [{ sha256: "A".repeat(64), mimeType: "image/png" }],
      [{ sha256: "a".repeat(64), mimeType: "image/svg+xml" }],
      [{ sha256: "a".repeat(64), mimeType: "image/png", content: "AQ==" }],
      Array.from({ length: 65 }, () => ({ sha256: "a".repeat(64), mimeType: "image/png" })),
    ]) {
      expect(transcriptImagesFromEntry(durableEntry("bad", "message", { images }))).toEqual({
        images: [],
        issue: INVALID_TRANSCRIPT_IMAGE_METADATA,
      });
    }
  });
});

describe("transcript image result decoding", () => {
  it("accepts one exact bounded result and rejects structural or sequencing drift", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const valid = responseFor(bytes, image, 0).result as Record<string, unknown>;
    expect(decodeTranscriptImageChunk(valid, image, 0)).toMatchObject({
      size: bytes.byteLength,
      offset: 0,
      nextOffset: bytes.byteLength,
      complete: true,
    });
    expect(
      decodeTranscriptImageChunk(
        {
          ...valid,
          nextOffset: 8,
          complete: false,
          content: base64(bytes.subarray(0, 8)),
        },
        image,
        0,
      ),
    ).toMatchObject({ offset: 0, nextOffset: 8, complete: false });

    for (const invalid of [
      { ...valid, sha256: "f".repeat(64) },
      { ...valid, mimeType: "image/webp" },
      { ...valid, size: 0 },
      { ...valid, offset: 1 },
      { ...valid, nextOffset: bytes.byteLength - 1 },
      { ...valid, complete: false },
      { ...valid, content: "AQJ=" },
      { ...valid, path: "/tmp/image" },
    ]) {
      expect(() => decodeTranscriptImageChunk(invalid, image, 0)).toThrow(
        TRANSCRIPT_IMAGE_PROTOCOL_ERROR,
      );
    }
  });
});

describe("bounded transcript image source", () => {
  it("deduplicates duplicate references, reconstructs sequentially, and revokes on dispose", async () => {
    const bytes = pngBytes(TRANSCRIPT_IMAGE_CHUNK_BYTES + 17);
    const image = await reference(bytes);
    const offsets: number[] = [];
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => {
        offsets.push(offset);
        return responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: (blob) => {
        blobs.push(blob);
        return "blob:verified";
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const releaseFirst = source.retain(image);
    const releaseSecond = source.retain({ ...image });
    const ready = await waitForStatus(source, image, "ready");

    expect(ready).toEqual({
      status: "ready",
      url: "blob:verified",
      mimeType: "image/png",
      size: bytes.byteLength,
    });
    expect(offsets).toEqual([0, TRANSCRIPT_IMAGE_CHUNK_BYTES]);
    expect(blobs).toHaveLength(1);
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(bytes);
    releaseFirst();
    releaseSecond();
    source.dispose();
    expect(revoked).toEqual(["blob:verified"]);
  });

  it("refuses digest and MIME magic mismatches before creating a URL", async () => {
    const valid = pngBytes(16, 1);
    const different = pngBytes(16, 2);
    const digestMismatch = await reference(different, { entryId: "digest-mismatch" });
    const gif = gifBytes();
    const mimeMismatch = await reference(gif, {
      entryId: "mime-mismatch",
      mimeType: "image/png",
    });
    let created = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (image, offset) =>
        responseFor(image.entryId === "digest-mismatch" ? valid : gif, image, offset),
      createObjectUrl: () => {
        created += 1;
        return `blob:${created}`;
      },
    });

    const releaseDigest = source.retain(digestMismatch);
    const digestError = await waitForStatus(source, digestMismatch, "error");
    const releaseMime = source.retain(mimeMismatch);
    const mimeError = await waitForStatus(source, mimeMismatch, "error");

    expect(digestError).toEqual({ status: "error", reason: TRANSCRIPT_IMAGE_INTEGRITY_ERROR });
    expect(mimeError).toEqual({ status: "error", reason: TRANSCRIPT_IMAGE_INTEGRITY_ERROR });
    expect(created).toBe(0);
    releaseDigest();
    releaseMime();
    source.dispose();
  });

  it("keeps retained URLs alive and evicts the least-recent unused URL", async () => {
    const firstBytes = pngBytes(16, 1);
    const secondBytes = pngBytes(16, 2);
    const first = await reference(firstBytes, { entryId: "first" });
    const second = await reference(secondBytes, { entryId: "second" });
    const revoked: string[] = [];
    let objectUrlSerial = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      maxCacheBytes: 32,
      maxCacheEntries: 1,
      readChunk: async (image, offset) =>
        responseFor(image.entryId === "first" ? firstBytes : secondBytes, image, offset),
      createObjectUrl: (blob) => {
        objectUrlSerial += 1;
        return `blob:${blob.size}:${objectUrlSerial}`;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const releaseFirst = source.retain(first);
    const firstReady = await waitForStatus(source, first, "ready");
    const releaseSecond = source.retain(second);
    expect(await waitForStatus(source, second, "error")).toEqual({
      status: "error",
      reason: TRANSCRIPT_IMAGE_CACHE_ERROR,
    });
    expect(revoked).toEqual([]);

    releaseFirst();
    const secondReady = await waitForStatus(source, second, "ready");
    expect(secondReady.status).toBe("ready");
    expect(revoked).toEqual([firstReady.status === "ready" ? firstReady.url : ""]);
    releaseSecond();
    source.dispose();
  });

  it("does not read while unavailable and resumes retained reads when access arrives", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: false, reason: "Waiting for the host." },
      readChunk: async (nextImage, offset) => {
        reads += 1;
        return responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: () => "blob:connected",
    });
    const release = source.retain(image);
    expect(source.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Waiting for the host.",
    });
    expect(reads).toBe(0);

    source.setAvailability({ available: true });
    expect((await waitForStatus(source, image, "ready")).status).toBe("ready");
    expect(reads).toBe(1);
    release();
    source.dispose();
  });

  it("clears transient failure state so a later retain can retry cleanly", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => {
        reads += 1;
        return reads === 1
          ? { accepted: false, error: { code: "connection_closed", message: "gone" } }
          : responseFor(bytes, nextImage, offset);
      },
      createObjectUrl: () => "blob:retry",
    });

    const releaseFailed = source.retain(image);
    expect((await waitForStatus(source, image, "error")).status).toBe("error");
    releaseFailed();
    const releaseReady = source.retain(image);
    expect(await waitForStatus(source, image, "ready")).toMatchObject({
      status: "ready",
      url: "blob:retry",
    });
    expect(reads).toBe(2);
    releaseReady();
    source.dispose();
  });

  it("bounds pathological tiny-chunk responses", async () => {
    const bytes = pngBytes(TRANSCRIPT_IMAGE_MAX_CHUNKS + 1);
    const image = await reference(bytes);
    let reads = 0;
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (_nextImage, offset) => {
        reads += 1;
        const nextOffset = offset + 1;
        return {
          accepted: true,
          result: {
            sha256: image.sha256,
            mimeType: image.mimeType,
            size: bytes.byteLength,
            offset,
            nextOffset,
            complete: nextOffset === bytes.byteLength,
            content: base64(bytes.subarray(offset, nextOffset)),
          },
        };
      },
    });
    const release = source.retain(image);

    expect(await waitForStatus(source, image, "error")).toEqual({
      status: "error",
      reason: TRANSCRIPT_IMAGE_PROTOCOL_ERROR,
    });
    expect(reads).toBe(TRANSCRIPT_IMAGE_MAX_CHUNKS);
    release();
    source.dispose();
  });

  it("revokes a just-created URL when disposal wins the final integrity race", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const revoked: string[] = [];
    let source!: ReturnType<typeof createTranscriptImageSource>;
    source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
      createObjectUrl: () => {
        source.dispose("Closed during image finalization.");
        return "blob:finalization-race";
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const release = source.retain(image);
    expect(await waitForStatus(source, image, "unavailable")).toEqual({
      status: "unavailable",
      reason: "Closed during image finalization.",
    });
    expect(revoked).toEqual(["blob:finalization-race"]);
    expect(source.getSnapshot(image)).toBe(source.getSnapshot(image));
    release();
    source.dispose();
    expect(revoked).toEqual(["blob:finalization-race"]);
  });

  it("revokes and removes a cached URL when the browser rejects its bytes", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const revoked: string[] = [];
    const source = createTranscriptImageSource({
      availability: { available: true },
      readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
      createObjectUrl: () => "blob:decode-failure",
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const release = source.retain(image);
    await waitForStatus(source, image, "ready");

    source.reportDecodeFailure(image);

    expect(source.getSnapshot(image)).toEqual({
      status: "error",
      reason: TRANSCRIPT_IMAGE_DECODE_ERROR,
    });
    expect(revoked).toEqual(["blob:decode-failure"]);
    release();
    source.dispose();
    expect(revoked).toEqual(["blob:decode-failure"]);
  });

  it("revokes registered URLs on authoritative session deletion", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const revoked: string[] = [];
    const source = createTranscriptImageSource({
      hostId: HOST,
      sessionId: SESSION,
      availability: { available: true },
      readChunk: async (nextImage, offset) => responseFor(bytes, nextImage, offset),
      createObjectUrl: () => "blob:authoritative",
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const release = source.retain(image);
    await waitForStatus(source, image, "ready");

    disposeTranscriptImagesForSession(HOST, SESSION);

    expect(revoked).toEqual(["blob:authoritative"]);
    expect(source.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "This session was removed from the host.",
    });
    release();
  });
});

describe("runtime capability gating", () => {
  function snapshot(): SessionSnapshotFrame {
    return {
      v: "omp-app/1",
      type: "snapshot",
      cursor: { epoch: "runtime-images", seq: 1 },
      revision: revision("runtime-images-revision"),
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      entries: [],
    };
  }

  it("keeps fixture/browser transcript images honestly unavailable", async () => {
    const image = await reference(pngBytes());
    const runtime = createFixtureSessionRuntime({ sessionKey: "fixture", variant: "default" });
    expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Transcript images are available only from a connected OMP host.",
    });
    runtime.dispose();
  });

  it("requires sessions.read and transcript.images before issuing a read", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.read"], []) });
    shell.emitFrame({ targetId: "local", frame: snapshot() });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    const release = runtime.transcriptImages.retain(image);

    expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "This OMP host does not offer transcript image reads.",
    });
    expect(shell.commandCount("session.image.read")).toBe(0);
    release();
    runtime.dispose();
    await controller.stop();
  });

  it("reads through the live runtime only after the attach acknowledgement", async () => {
    const bytes = pngBytes();
    const image = await reference(bytes);
    const shell = new FakeShell();
    const attachGate = deferred<void>();
    shell.command = async (request: CommandRequest): Promise<CommandResult> => {
      shell.commands.push(request);
      if (request.intent.command === "session.attach") await attachGate.promise;
      const result =
        request.intent.command === "session.image.read"
          ? responseFor(bytes, image, Number(request.intent.args?.offset)).result
          : { accepted: true };
      return {
        targetId: request.targetId,
        requestId: `runtime-image-${shell.commands.length}`,
        commandId: `runtime-image-command-${shell.commands.length}`,
        accepted: true,
        result,
      };
    };
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.read"]),
    });
    shell.emitFrame({ targetId: "local", frame: snapshot() });
    // app-wire 0.5.4 intentionally rejects unknown negotiated features. Add
    // the incoming 0.5.5 feature at the controller snapshot seam until that
    // package is vendored; all runtime/attach behavior below stays real.
    const getBaseSnapshot = controller.getSnapshot.bind(controller);
    controller.getSnapshot = () => {
      const current = getBaseSnapshot();
      const host = current.hosts.get(HOST);
      if (host === undefined) return current;
      const hosts = new Map(current.hosts);
      hosts.set(HOST, {
        ...host,
        grantedFeatures: [...host.grantedFeatures, "transcript.images"],
      });
      return { ...current, hosts };
    };
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    const release = runtime.transcriptImages.retain(image);
    expect(runtime.transcriptImages.getSnapshot(image)).toEqual({
      status: "unavailable",
      reason: "Waiting for this session to finish connecting.",
    });
    expect(shell.commandCount("session.image.read")).toBe(0);
    attachGate.resolve(undefined);
    expect((await waitForStatus(runtime.transcriptImages, image, "ready")).status).toBe("ready");
    expect(
      shell.commands.map((request) => request.intent.command).filter((command) =>
        command.startsWith("session.image"),
      ),
    ).toEqual(["session.image.read"]);
    expect(shell.commands.find((request) => request.intent.command === "session.image.read")?.intent.args)
      .toEqual({ entryId: image.entryId, sha256: image.sha256, offset: 0 });

    release();
    runtime.dispose();
    await controller.stop();
  });
});
