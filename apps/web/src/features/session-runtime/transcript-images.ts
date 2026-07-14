// Bounded transcript-image transport and object-URL cache. The app-wire
// projection carries metadata only; bytes are read sequentially from the
// attached host, verified, then retained outside React and the projection.
import type {
  TranscriptImageMimeType,
  TranscriptImageReference,
} from "../transcript/image-metadata.ts";

export const TRANSCRIPT_IMAGE_CHUNK_BYTES = 256 * 1024;
export const TRANSCRIPT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const TRANSCRIPT_IMAGE_MAX_CHUNKS = 128;
export const TRANSCRIPT_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
export const TRANSCRIPT_IMAGE_CACHE_ENTRIES = 32;

const TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES = Math.ceil(TRANSCRIPT_IMAGE_CHUNK_BYTES / 3) * 4;

export const TRANSCRIPT_IMAGE_LOAD_ERROR = "This image could not be loaded from the host.";
export const TRANSCRIPT_IMAGE_PROTOCOL_ERROR = "The host returned invalid transcript image data.";
export const TRANSCRIPT_IMAGE_INTEGRITY_ERROR = "This transcript image failed its integrity check.";
export const TRANSCRIPT_IMAGE_DECODE_ERROR = "This image could not be decoded.";
export const TRANSCRIPT_IMAGE_CACHE_ERROR =
  "This image cannot fit in the bounded transcript image cache right now.";
export const TRANSCRIPT_IMAGE_FIXTURE_REASON =
  "Transcript images are available only from a connected OMP host.";

export type TranscriptImageAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export type TranscriptImageSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string; readonly mimeType: TranscriptImageMimeType; readonly size: number }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface TranscriptImageSource {
  getSnapshot(reference: TranscriptImageReference): TranscriptImageSnapshot;
  subscribe(reference: TranscriptImageReference, listener: () => void): () => void;
  retain(reference: TranscriptImageReference): () => void;
  reportDecodeFailure(reference: TranscriptImageReference): void;
  dispose(reason?: string): void;
}

export interface TranscriptImageCommandResult {
  readonly accepted: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface TranscriptImageSourceOptions {
  readonly readChunk: (
    reference: TranscriptImageReference,
    offset: number,
  ) => Promise<TranscriptImageCommandResult>;
  readonly availability?: TranscriptImageAvailability;
  readonly hostId?: string;
  readonly sessionId?: string;
  readonly maxCacheBytes?: number;
  readonly maxCacheEntries?: number;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly digest?: (bytes: Uint8Array) => Promise<string>;
}

export interface DecodedTranscriptImageChunk {
  readonly sha256: string;
  readonly mimeType: TranscriptImageMimeType;
  readonly size: number;
  readonly offset: number;
  readonly nextOffset: number;
  readonly complete: boolean;
  readonly bytes: Uint8Array;
}

interface CacheEntry {
  readonly key: string;
  readonly reference: TranscriptImageReference;
  readonly listeners: Set<() => void>;
  refCount: number;
  lastUsed: number;
  state: "idle" | "loading" | "ready" | "error";
  snapshot: TranscriptImageSnapshot | null;
  retryable: boolean;
  promise: Promise<void> | null;
  url: string | null;
  size: number;
  reservedSize: number;
}

class TranscriptImageFailure extends Error {
  readonly reason: string;
  readonly retryable: boolean;

  constructor(reason: string, retryable: boolean) {
    super(reason);
    this.name = "TranscriptImageFailure";
    this.reason = reason;
    this.retryable = retryable;
  }
}

const LOADING_SNAPSHOT: TranscriptImageSnapshot = Object.freeze({ status: "loading" });

function unavailableSnapshot(reason: string): TranscriptImageSnapshot {
  return Object.freeze({ status: "unavailable", reason });
}

function imageKey(reference: TranscriptImageReference): string {
  return `${reference.entryId}\u0000${reference.sha256}\u0000${reference.mimeType}`;
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalBase64Bytes(content: unknown): Uint8Array {
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    content.length > TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES ||
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(content)
  ) {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (padding === 2 && (alphabet.indexOf(content[content.length - 3] ?? "") & 0x0f) !== 0) ||
    (padding === 1 && (alphabet.indexOf(content[content.length - 2] ?? "") & 0x03) !== 0)
  ) {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  const decodedLength = (content.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > TRANSCRIPT_IMAGE_CHUNK_BYTES) {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  let binary: string;
  try {
    binary = atob(content);
  } catch {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  if (binary.length !== decodedLength) {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  const bytes = new Uint8Array(decodedLength);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Strict local mirror of app-wire 0.5.5's session.image.read result. */
export function decodeTranscriptImageChunk(
  value: unknown,
  reference: TranscriptImageReference,
  requestedOffset: number,
  expectedSize?: number,
): DecodedTranscriptImageChunk {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "sha256",
      "mimeType",
      "size",
      "offset",
      "nextOffset",
      "complete",
      "content",
    ]) ||
    value.sha256 !== reference.sha256 ||
    value.mimeType !== reference.mimeType ||
    !safeInteger(value.size) ||
    value.size <= 0 ||
    value.size > TRANSCRIPT_IMAGE_MAX_BYTES ||
    (expectedSize !== undefined && value.size !== expectedSize) ||
    !safeInteger(value.offset) ||
    value.offset !== requestedOffset ||
    !safeInteger(value.nextOffset) ||
    value.nextOffset <= value.offset ||
    value.nextOffset > value.size ||
    typeof value.complete !== "boolean" ||
    value.complete !== (value.nextOffset === value.size)
  ) {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  const bytes = canonicalBase64Bytes(value.content);
  if (bytes.byteLength !== value.nextOffset - value.offset) {
    throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
  }
  return {
    sha256: reference.sha256,
    mimeType: reference.mimeType,
    size: value.size,
    offset: value.offset,
    nextOffset: value.nextOffset,
    complete: value.complete,
    bytes,
  };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Byte authority for transcript image MIME; metadata alone is not trusted. */
export function sniffTranscriptImageMimeType(bytes: Uint8Array): TranscriptImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.byteLength >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function defaultDigest(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

function validLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

const sourcesBySession = new Map<string, Set<ManagedTranscriptImageSource>>();

function registerSource(hostId: string, sessionId: string, source: ManagedTranscriptImageSource): void {
  const key = sessionKey(hostId, sessionId);
  const sources = sourcesBySession.get(key) ?? new Set<ManagedTranscriptImageSource>();
  sources.add(source);
  sourcesBySession.set(key, sources);
}

function unregisterSource(hostId: string, sessionId: string, source: ManagedTranscriptImageSource): void {
  const key = sessionKey(hostId, sessionId);
  const sources = sourcesBySession.get(key);
  if (sources === undefined) return;
  sources.delete(source);
  if (sources.size === 0) sourcesBySession.delete(key);
}

/** Dispose all renderer-owned URLs only after authoritative host deletion. */
export function disposeTranscriptImagesForSession(hostId: string, sessionId: string): void {
  const key = sessionKey(hostId, sessionId);
  const sources = sourcesBySession.get(key);
  if (sources === undefined) return;
  sourcesBySession.delete(key);
  for (const source of sources) {
    source.dispose("This session was removed from the host.");
  }
}

export class ManagedTranscriptImageSource implements TranscriptImageSource {
  private readonly readChunk: TranscriptImageSourceOptions["readChunk"];
  private readonly maxCacheBytes: number;
  private readonly maxCacheEntries: number;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly digest: (bytes: Uint8Array) => Promise<string>;
  private readonly hostId: string | undefined;
  private readonly sessionId: string | undefined;
  private readonly entries = new Map<string, CacheEntry>();
  private availability: TranscriptImageAvailability;
  private unavailable: TranscriptImageSnapshot | null;
  private disposedReason: string | null = null;
  private disposedSnapshot: TranscriptImageSnapshot | null = null;
  private residentBytes = 0;
  private reservedBytes = 0;
  private clock = 0;

  constructor(options: TranscriptImageSourceOptions) {
    this.readChunk = options.readChunk;
    this.maxCacheBytes = validLimit(
      options.maxCacheBytes ?? TRANSCRIPT_IMAGE_CACHE_BYTES,
      "maxCacheBytes",
    );
    this.maxCacheEntries = validLimit(
      options.maxCacheEntries ?? TRANSCRIPT_IMAGE_CACHE_ENTRIES,
      "maxCacheEntries",
    );
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.digest = options.digest ?? defaultDigest;
    this.availability = options.availability ?? {
      available: false,
      reason: TRANSCRIPT_IMAGE_FIXTURE_REASON,
    };
    this.unavailable = this.availability.available
      ? null
      : unavailableSnapshot(this.availability.reason);
    this.hostId = options.hostId;
    this.sessionId = options.sessionId;
    if (this.hostId !== undefined && this.sessionId !== undefined) {
      registerSource(this.hostId, this.sessionId, this);
    }
  }

  setAvailability(availability: TranscriptImageAvailability): void {
    if (this.disposedReason !== null) return;
    const unchanged =
      this.availability.available === availability.available &&
      (this.availability.available ||
        (!availability.available && this.availability.reason === availability.reason));
    if (unchanged) return;
    const becameAvailable = !this.availability.available && availability.available;
    this.availability = availability;
    this.unavailable = availability.available ? null : unavailableSnapshot(availability.reason);
    for (const entry of this.entries.values()) {
      if (becameAvailable && entry.state === "error" && entry.retryable) {
        entry.state = "idle";
        entry.snapshot = null;
      }
      this.notify(entry);
      if (availability.available && entry.refCount > 0 && entry.state === "idle") {
        this.start(entry);
      }
    }
  }

  getSnapshot(reference: TranscriptImageReference): TranscriptImageSnapshot {
    if (this.disposedSnapshot !== null) return this.disposedSnapshot;
    const entry = this.entries.get(imageKey(reference));
    if (entry?.state === "ready" && entry.snapshot !== null) return entry.snapshot;
    if (this.unavailable !== null) return this.unavailable;
    if (entry?.state === "error" && entry.snapshot !== null) return entry.snapshot;
    return LOADING_SNAPSHOT;
  }

  subscribe(reference: TranscriptImageReference, listener: () => void): () => void {
    if (this.disposedReason !== null) return () => undefined;
    const entry = this.ensureEntry(reference);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  retain(reference: TranscriptImageReference): () => void {
    if (this.disposedReason !== null) return () => undefined;
    const entry = this.ensureEntry(reference);
    const wasUnused = entry.refCount === 0;
    entry.refCount += 1;
    this.touch(entry);
    if (wasUnused && entry.state === "error" && entry.retryable) {
      entry.state = "idle";
      entry.snapshot = null;
      this.notify(entry);
    }
    if (this.availability.available && entry.state === "idle") this.start(entry);
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      const current = this.entries.get(entry.key);
      if (current !== entry) return;
      entry.refCount = Math.max(0, entry.refCount - 1);
      this.touch(entry);
      if (entry.refCount === 0) this.retryCapacityWaiters();
    };
  }

  reportDecodeFailure(reference: TranscriptImageReference): void {
    if (this.disposedReason !== null) return;
    const entry = this.entries.get(imageKey(reference));
    if (entry?.state !== "ready") return;
    this.releaseReadyUrl(entry);
    entry.state = "error";
    entry.retryable = false;
    entry.snapshot = Object.freeze({
      status: "error",
      reason: TRANSCRIPT_IMAGE_DECODE_ERROR,
    });
    this.notify(entry);
    this.retryCapacityWaiters();
  }

  dispose(reason = "Transcript image cache was closed."): void {
    if (this.disposedReason !== null) return;
    this.disposedReason = reason;
    this.disposedSnapshot = unavailableSnapshot(reason);
    if (this.hostId !== undefined && this.sessionId !== undefined) {
      unregisterSource(this.hostId, this.sessionId, this);
    }
    const listeners: Array<() => void> = [];
    for (const entry of this.entries.values()) {
      this.releaseReadyUrl(entry);
      listeners.push(...entry.listeners);
    }
    this.entries.clear();
    this.residentBytes = 0;
    this.reservedBytes = 0;
    for (const listener of listeners) listener();
  }

  private ensureEntry(reference: TranscriptImageReference): CacheEntry {
    const key = imageKey(reference);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const entry: CacheEntry = {
      key,
      reference,
      listeners: new Set(),
      refCount: 0,
      lastUsed: 0,
      state: "idle",
      snapshot: null,
      retryable: false,
      promise: null,
      url: null,
      size: 0,
      reservedSize: 0,
    };
    this.touch(entry);
    this.entries.set(key, entry);
    return entry;
  }

  private touch(entry: CacheEntry): void {
    this.clock += 1;
    entry.lastUsed = this.clock;
  }

  private notify(entry: CacheEntry): void {
    for (const listener of entry.listeners) listener();
  }

  private retryCapacityWaiters(): void {
    if (this.disposedReason !== null || !this.availability.available) return;
    for (const entry of this.entries.values()) {
      if (
        entry.refCount > 0 &&
        entry.state === "error" &&
        entry.retryable &&
        entry.snapshot?.status === "error" &&
        entry.snapshot.reason === TRANSCRIPT_IMAGE_CACHE_ERROR
      ) {
        entry.state = "idle";
        entry.snapshot = null;
        this.notify(entry);
        this.start(entry);
      }
    }
  }

  private start(entry: CacheEntry): void {
    if (
      this.disposedReason !== null ||
      !this.availability.available ||
      entry.state !== "idle" ||
      entry.promise !== null
    ) {
      return;
    }
    entry.state = "loading";
    entry.snapshot = null;
    this.notify(entry);
    const promise = this.load(entry);
    entry.promise = promise;
    void promise.finally(() => {
      if (entry.promise === promise) entry.promise = null;
    });
  }

  private async load(entry: CacheEntry): Promise<void> {
    try {
      const bytes = await this.readAll(entry);
      const digest = await this.digest(bytes);
      this.assertCurrent(entry);
      if (digest !== entry.reference.sha256) {
        throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_INTEGRITY_ERROR, false);
      }
      if (sniffTranscriptImageMimeType(bytes) !== entry.reference.mimeType) {
        throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_INTEGRITY_ERROR, false);
      }
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
        type: entry.reference.mimeType,
      });
      const url = this.createObjectUrl(blob);
      try {
        this.assertCurrent(entry);
      } catch (error) {
        this.safeRevoke(url);
        throw error;
      }
      this.commitReservation(entry);
      entry.url = url;
      entry.size = bytes.byteLength;
      entry.state = "ready";
      entry.retryable = false;
      entry.snapshot = Object.freeze({
        status: "ready",
        url,
        mimeType: entry.reference.mimeType,
        size: bytes.byteLength,
      });
      this.touch(entry);
      this.notify(entry);
    } catch (error) {
      this.releaseReservation(entry);
      if (this.disposedReason !== null || this.entries.get(entry.key) !== entry) return;
      const failure =
        error instanceof TranscriptImageFailure
          ? error
          : new TranscriptImageFailure(TRANSCRIPT_IMAGE_LOAD_ERROR, true);
      entry.state = "error";
      entry.retryable = failure.retryable;
      entry.snapshot = Object.freeze({ status: "error", reason: failure.reason });
      this.notify(entry);
    }
  }

  private async readAll(entry: CacheEntry): Promise<Uint8Array> {
    let offset = 0;
    let chunks = 0;
    let expectedSize: number | undefined;
    let bytes: Uint8Array | undefined;
    while (true) {
      chunks += 1;
      if (chunks > TRANSCRIPT_IMAGE_MAX_CHUNKS) {
        throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_PROTOCOL_ERROR, false);
      }
      this.assertCurrent(entry);
      if (!this.availability.available) {
        throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_LOAD_ERROR, true);
      }
      let response: TranscriptImageCommandResult;
      try {
        response = await this.readChunk(entry.reference, offset);
      } catch {
        throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_LOAD_ERROR, true);
      }
      this.assertCurrent(entry);
      if (!response.accepted) {
        const code = response.error?.code ?? "";
        const retryable =
          code === "connection_closed" ||
          code === "session_not_attached" ||
          code === "outcome_unknown";
        throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_LOAD_ERROR, retryable);
      }
      const chunk = decodeTranscriptImageChunk(
        response.result,
        entry.reference,
        offset,
        expectedSize,
      );
      if (bytes === undefined) {
        if (!this.reserve(entry, chunk.size)) {
          throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_CACHE_ERROR, true);
        }
        expectedSize = chunk.size;
        bytes = new Uint8Array(chunk.size);
      }
      bytes.set(chunk.bytes, chunk.offset);
      offset = chunk.nextOffset;
      if (chunk.complete) return bytes;
    }
  }

  private assertCurrent(entry: CacheEntry): void {
    if (this.disposedReason !== null || this.entries.get(entry.key) !== entry) {
      throw new TranscriptImageFailure(TRANSCRIPT_IMAGE_LOAD_ERROR, false);
    }
  }

  private reserve(entry: CacheEntry, size: number): boolean {
    if (size > this.maxCacheBytes) return false;
    while (
      this.residentBytes + this.reservedBytes + size > this.maxCacheBytes ||
      this.readyAndReservedEntries() + 1 > this.maxCacheEntries
    ) {
      const candidate = [...this.entries.values()]
        .filter((item) => item !== entry && item.state === "ready" && item.refCount === 0)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (candidate === undefined) return false;
      this.evict(candidate);
    }
    entry.reservedSize = size;
    this.reservedBytes += size;
    return true;
  }

  private readyAndReservedEntries(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "ready" || entry.reservedSize > 0) count += 1;
    }
    return count;
  }

  private commitReservation(entry: CacheEntry): void {
    const size = entry.reservedSize;
    if (size <= 0) return;
    this.reservedBytes -= size;
    this.residentBytes += size;
    entry.reservedSize = 0;
  }

  private releaseReservation(entry: CacheEntry): void {
    if (entry.reservedSize <= 0) return;
    this.reservedBytes -= entry.reservedSize;
    entry.reservedSize = 0;
  }

  private evict(entry: CacheEntry): void {
    if (entry.refCount !== 0 || entry.state !== "ready") return;
    this.entries.delete(entry.key);
    this.releaseReadyUrl(entry);
  }

  private releaseReadyUrl(entry: CacheEntry): void {
    const url = entry.url;
    const size = entry.size;
    entry.url = null;
    entry.size = 0;
    this.residentBytes = Math.max(0, this.residentBytes - size);
    if (url !== null) this.safeRevoke(url);
  }

  private safeRevoke(url: string): void {
    try {
      this.revokeObjectUrl(url);
    } catch {
      // Revocation is best effort, but bookkeeping and other URLs still clear.
    }
  }
}

export function createTranscriptImageSource(
  options: TranscriptImageSourceOptions,
): ManagedTranscriptImageSource {
  return new ManagedTranscriptImageSource(options);
}
