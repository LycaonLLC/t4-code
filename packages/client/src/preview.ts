export const PREVIEW_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_CAPTURE_MAX_PIXELS = 16 * 1024 * 1024;
export const PREVIEW_CAPTURE_READ_CHUNK_BYTES = 256 * 1024;

export interface PreviewIdentity {
  readonly hostId: string;
  readonly sessionId: string;
  readonly previewId: string;
}

export interface PreviewCaptureMetadata {
  readonly captureId: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
  readonly sha256: string;
}

export interface PreviewCaptureReadResult {
  readonly previewId: string;
  readonly captureId: string;
  readonly size: number;
  readonly offset: number;
  readonly nextOffset: number;
  readonly complete: boolean;
  readonly content: string;
}

export interface PreviewCaptureResourceOptions {
  readonly read: (
    identity: PreviewIdentity,
    captureId: string,
    offset: number,
  ) => Promise<PreviewCaptureReadResult>;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
}

interface CaptureResource {
  readonly capture: PreviewCaptureMetadata;
  blob?: Blob;
  url?: string;
  loading?: Promise<Blob> | undefined;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`invalid preview capture ${name}`);
}

function identityKey(identity: PreviewIdentity): string {
  return `${identity.hostId}\u0000${identity.sessionId}\u0000${identity.previewId}`;
}

export function previewKey(identity: PreviewIdentity): string {
  return identityKey(identity);
}

function assertMetadata(capture: PreviewCaptureMetadata): void {
  positiveInteger(capture.size, "size");
  positiveInteger(capture.width, "width");
  positiveInteger(capture.height, "height");
  if (capture.size > PREVIEW_CAPTURE_MAX_BYTES)
    throw new Error("preview capture exceeds byte limit");
  if (
    capture.width > PREVIEW_CAPTURE_MAX_PIXELS ||
    capture.height > PREVIEW_CAPTURE_MAX_PIXELS ||
    capture.width * capture.height > PREVIEW_CAPTURE_MAX_PIXELS
  )
    throw new Error("preview capture exceeds pixel limit");
  if (!/^[a-f0-9]{64}$/u.test(capture.sha256)) throw new Error("invalid preview capture hash");
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value))
    throw new Error("invalid preview capture base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (padding === 2 && (alphabet.indexOf(value[value.length - 3]!) & 0x0f) !== 0) ||
    (padding === 1 && (alphabet.indexOf(value[value.length - 2]!) & 0x03) !== 0)
  ) {
    throw new Error("non-canonical preview capture base64");
  }
  if (typeof atob === "function") {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function parsedDimensions(
  bytes: Uint8Array,
  mimeType: PreviewCaptureMetadata["mimeType"],
): readonly [number, number] | undefined {
  const read32 = (offset: number): number =>
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0;
  if (mimeType === "image/png") {
    if (
      bytes.length < 24 ||
      String.fromCharCode(...bytes.slice(1, 4)) !== "PNG" ||
      String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
    )
      throw new Error("preview capture bytes are not PNG");
    return [read32(16), read32(20)];
  }
  if (mimeType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
      throw new Error("preview capture bytes are not JPEG");
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset] !== 0xff) throw new Error("invalid JPEG marker");
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 1 >= bytes.length) break;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (length < 2 || offset + length > bytes.length) throw new Error("invalid JPEG segment");
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      )
        return [
          (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
          (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        ];
      offset += length;
    }
    throw new Error("JPEG preview capture has no dimensions");
  }
  if (
    bytes.length < 16 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
  )
    throw new Error("preview capture bytes are not WebP");
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30)
    return [
      1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
      1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
    ];
  if (
    chunk === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  )
    return [((bytes[27]! << 8) | bytes[26]!) & 0x3fff, ((bytes[29]! << 8) | bytes[28]!) & 0x3fff];
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  throw new Error("unsupported WebP preview capture");
}

function assertRaster(bytes: Uint8Array, capture: PreviewCaptureMetadata): void {
  if (bytes.byteLength !== capture.size) throw new Error("preview capture size mismatch");
  const dimensions = parsedDimensions(bytes, capture.mimeType);
  if (dimensions === undefined) throw new Error("preview capture dimensions unavailable");
  const [width, height] = dimensions;
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (width * height > PREVIEW_CAPTURE_MAX_PIXELS)
    throw new Error("preview capture raster exceeds pixel limit");
  if (width !== capture.width || height !== capture.height)
    throw new Error("preview capture dimensions mismatch");
}

async function defaultSha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Owns decoded preview pixels and their object URLs; projections retain metadata only. */
export class PreviewCaptureResource {
  private readonly resources = new Map<string, CaptureResource>();
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly sha256: (bytes: Uint8Array) => Promise<string>;
  private readonly options: PreviewCaptureResourceOptions;

  constructor(options: PreviewCaptureResourceOptions) {
    this.options = options;
    this.createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    this.sha256 = options.sha256 ?? defaultSha256;
  }

  async objectUrl(identity: PreviewIdentity, capture: PreviewCaptureMetadata): Promise<string> {
    assertMetadata(capture);
    const key = identityKey(identity);
    let resource = this.resources.get(key);
    if (
      resource === undefined ||
      resource.capture.captureId !== capture.captureId ||
      resource.capture.sha256 !== capture.sha256
    ) {
      this.release(identity);
      resource = { capture };
      this.resources.set(key, resource);
    }
    if (resource.url !== undefined) return resource.url;
    try {
      const blob = await this.loadResource(key, resource, identity);
      if (this.resources.get(key) !== resource)
        throw new Error("preview capture was replaced while loading");
      if (resource.url === undefined) resource.url = this.createObjectURL(blob);
      return resource.url;
    } catch (error) {
      if (this.resources.get(key) === resource && resource.url === undefined)
        this.resources.delete(key);
      throw error;
    }
  }

  replace(identity: PreviewIdentity, capture: PreviewCaptureMetadata | undefined): void {
    const current = this.resources.get(identityKey(identity));
    if (
      current !== undefined &&
      (capture === undefined ||
        current.capture.captureId !== capture.captureId ||
        current.capture.sha256 !== capture.sha256)
    )
      this.release(identity);
  }

  release(identity: PreviewIdentity): void {
    const resource = this.resources.get(identityKey(identity));
    if (resource?.url !== undefined) this.revokeObjectURL(resource.url);
    this.resources.delete(identityKey(identity));
  }

  retain(identities: Iterable<PreviewIdentity>): void {
    const retained = new Set<string>();
    for (const identity of identities) retained.add(identityKey(identity));
    for (const [key, resource] of this.resources)
      if (!retained.has(key)) {
        if (resource.url !== undefined) this.revokeObjectURL(resource.url);
        this.resources.delete(key);
      }
  }

  dispose(): void {
    for (const resource of this.resources.values())
      if (resource.url !== undefined) this.revokeObjectURL(resource.url);
    this.resources.clear();
  }

  private loadResource(
    key: string,
    resource: CaptureResource,
    identity: PreviewIdentity,
  ): Promise<Blob> {
    if (resource.blob !== undefined) return Promise.resolve(resource.blob);
    if (resource.loading !== undefined) return resource.loading;
    const loading = this.load(identity, resource.capture)
      .then((blob) => {
        if (this.resources.get(key) !== resource)
          throw new Error("preview capture was replaced while loading");
        resource.blob = blob;
        return blob;
      })
      .finally(() => {
        if (this.resources.get(key) === resource) resource.loading = undefined;
      });
    resource.loading = loading;
    return loading;
  }

  private async load(identity: PreviewIdentity, capture: PreviewCaptureMetadata): Promise<Blob> {
    const bytes = new Uint8Array(capture.size);
    let offset = 0;
    while (offset < capture.size) {
      const chunk = await this.options.read(identity, capture.captureId, offset);
      if (
        chunk.previewId !== identity.previewId ||
        chunk.captureId !== capture.captureId ||
        chunk.size !== capture.size ||
        chunk.offset !== offset
      )
        throw new Error("preview capture chunk identity or offset mismatch");
      if (
        !Number.isSafeInteger(chunk.nextOffset) ||
        chunk.nextOffset <= offset ||
        chunk.nextOffset > capture.size ||
        chunk.nextOffset - offset > PREVIEW_CAPTURE_READ_CHUNK_BYTES ||
        chunk.complete !== (chunk.nextOffset === capture.size)
      )
        throw new Error("preview capture chunk bounds mismatch");
      const content = decodeBase64(chunk.content);
      if (content.byteLength !== chunk.nextOffset - offset)
        throw new Error("preview capture chunk size mismatch");
      bytes.set(content, offset);
      offset = chunk.nextOffset;
    }
    const hash = await this.sha256(bytes);
    if (hash !== capture.sha256) throw new Error("preview capture hash mismatch");
    assertRaster(bytes, capture);
    return new Blob([bytes], { type: capture.mimeType });
  }
}

export interface PreviewLeaseIdentity extends PreviewIdentity {
  readonly leaseId?: string;
}

export interface PreviewLeaseManagerClient {
  previewLeaseAcquire(identity: PreviewIdentity, ttlMs?: number): Promise<unknown>;
  previewLeaseRenew(identity: PreviewLeaseIdentity, ttlMs?: number): Promise<unknown>;
  previewLeaseRelease(identity: PreviewLeaseIdentity): Promise<unknown>;
}

export interface PreviewLeaseManagerOptions {
  readonly now?: () => number;
  readonly defaultTtlMs?: number;
}

interface PreviewLease {
  readonly identity: PreviewIdentity;
  readonly leaseId: string;
  readonly expiresAt: number;
  readonly ttlMs: number;
}

function validLeaseResult(
  result: unknown,
  identity: PreviewIdentity,
): { readonly leaseId: string; readonly expiresAt: number } | undefined {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("previewId" in result) ||
    !("leaseId" in result) ||
    !("expiresAt" in result)
  )
    return undefined;
  const { previewId, leaseId, expiresAt } = result;
  if (
    previewId !== identity.previewId ||
    typeof leaseId !== "string" ||
    leaseId.length === 0 ||
    leaseId.length > 256 ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  )
    return undefined;
  return { leaseId, expiresAt };
}

function leaseResponse(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("ok" in value) ||
    value.ok !== true ||
    !("result" in value)
  )
    return undefined;
  return value.result;
}

/**
 * Owns cooperative preview leases, independently of capture byte/object-URL
 * resources. A lease is keyed by the complete preview identity and is never
 * supplied to a different preview.
 */
export class PreviewLeaseManager {
  private readonly leases = new Map<string, PreviewLease>();
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly client: PreviewLeaseManagerClient;

  constructor(client: PreviewLeaseManagerClient, options: PreviewLeaseManagerOptions = {}) {
    this.client = client;
    this.now = options.now ?? Date.now;
    this.defaultTtlMs =
      options.defaultTtlMs !== undefined &&
      Number.isSafeInteger(options.defaultTtlMs) &&
      options.defaultTtlMs > 0
        ? options.defaultTtlMs
        : 30_000;
  }

  /** Acquire only when a usable lease is absent; renew once half its TTL has elapsed. */
  async ensure(identity: PreviewIdentity, ttlMs = this.defaultTtlMs): Promise<string> {
    const key = identityKey(identity);
    const previous = this.leases.get(key);
    if (previous !== undefined && this.now() < previous.expiresAt) {
      if (this.now() < previous.expiresAt - Math.floor(previous.ttlMs / 2))
        return previous.leaseId;
      return this.renew(identity, ttlMs);
    }
    this.leases.delete(key);
    const response = await this.client.previewLeaseAcquire(identity, ttlMs);
    const lease = validLeaseResult(leaseResponse(response), identity);
    if (lease === undefined) throw new Error("invalid preview lease acquire response");
    this.leases.set(key, Object.freeze({ identity: { ...identity }, ...lease, ttlMs }));
    return lease.leaseId;
  }

  async renew(identity: PreviewIdentity, ttlMs = this.defaultTtlMs): Promise<string> {
    const key = identityKey(identity);
    const previous = this.leases.get(key);
    if (previous === undefined) return this.ensure(identity, ttlMs);
    try {
      const response = await this.client.previewLeaseRenew(
        { ...identity, leaseId: previous.leaseId },
        ttlMs,
      );
      const lease = validLeaseResult(leaseResponse(response), identity);
      if (lease === undefined) throw new Error("invalid preview lease renew response");
      this.leases.set(key, Object.freeze({ identity: { ...identity }, ...lease, ttlMs }));
      return lease.leaseId;
    } catch (error) {
      this.leases.delete(key);
      throw error;
    }
  }

  /**
   * Runs a mutation with a matching lease. Transport and ownership failures
   * invalidate that lease so no later mutation can accidentally reuse it.
   */
  async mutate<T>(
    identity: PreviewIdentity,
    operation: (leaseId: string) => Promise<T>,
    ttlMs = this.defaultTtlMs,
  ): Promise<T> {
    const leaseId = await this.ensure(identity, ttlMs);
    try {
      return await operation(leaseId);
    } catch (error) {
      let code = "";
      if (error !== null && typeof error === "object" && "code" in error)
        code = String(error.code);
      if (
        /transport|ownership|owner|lease|closed/i.test(code) ||
        ["FORBIDDEN", "CONFLICT", "NOT_FOUND"].includes(code)
      )
        this.invalidate(identity);
      throw error;
    }
  }

  /** Long handoffs renew before the lease reaches its half-TTL threshold. */
  async beforeHandoff(identity: PreviewIdentity, timeoutMs?: number): Promise<string> {
    const ttlMs =
      timeoutMs !== undefined && Number.isSafeInteger(timeoutMs) && timeoutMs > this.defaultTtlMs / 2
        ? Math.min(timeoutMs * 2, 300_000)
        : this.defaultTtlMs;
    return this.ensure(identity, ttlMs);
  }

  invalidate(identity: PreviewIdentity): void {
    this.leases.delete(identityKey(identity));
  }

  async release(identity: PreviewIdentity): Promise<void> {
    const key = identityKey(identity);
    const lease = this.leases.get(key);
    this.leases.delete(key);
    if (lease === undefined) return;
    try {
      await this.client.previewLeaseRelease({ ...identity, leaseId: lease.leaseId });
    } catch {
      // Teardown must not retain or resurrect a lease after a transport loss.
    }
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.leases.values()].map((lease) => this.release(lease.identity)));
  }
}
