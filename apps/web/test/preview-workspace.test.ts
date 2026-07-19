import {
  PreviewCaptureResource,
  type DesktopRuntimeController,
  type PreviewProjection,
} from "@t4-code/client";
import type { CommandResult } from "@t4-code/protocol/desktop-ipc";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  choosePreview,
  defaultLaunchAuthority,
  derivePreviewWorkspaceStatus,
  displayedToNativeCoordinate,
  isProjectRelativeUploadPath,
  previewHostSupport,
  parsePreviewPolicyDecision,
  previewActionSupport,
} from "../src/features/preview/preview-model.ts";
import { PreviewDesktopAdapter } from "../src/features/preview/preview-runtime.ts";

const identity = { hostId: "host-a", sessionId: "session-a", previewId: "preview-a" };
const address = { targetId: "target-a", hostId: identity.hostId, sessionId: identity.sessionId };

function preview(patch: Partial<PreviewProjection> = {}): PreviewProjection {
  return {
    ...identity,
    revision: "1",
    cursor: "cursor" as unknown as PreviewProjection["cursor"],
    state: "ready",
    freshness: "fresh",
    availableActions: ["navigate", "click", "capture", "upload"],
    ...patch,
  };
}

function accepted(result: unknown): CommandResult {
  return {
    targetId: address.targetId,
    requestId: "request" as CommandResult["requestId"],
    commandId: "command" as CommandResult["commandId"],
    accepted: true,
    result,
  };
}

describe("preview workspace policy", () => {
  it("derives launching, ready, running, stopped, failed, cached, offline, and unsupported states", () => {
    expect(derivePreviewWorkspaceStatus({ preview: undefined, connected: true, supported: true })).toBe("empty");
    expect(derivePreviewWorkspaceStatus({ preview: preview({ state: "launching" }), connected: true, supported: true })).toBe("launching");
    expect(derivePreviewWorkspaceStatus({ preview: preview({ state: "running" }), connected: true, supported: true })).toBe("running");
    expect(derivePreviewWorkspaceStatus({ preview: preview({ state: "stopped" }), connected: true, supported: true })).toBe("stopped");
    expect(derivePreviewWorkspaceStatus({ preview: preview({ state: "failed" }), connected: true, supported: true })).toBe("failed");
    expect(derivePreviewWorkspaceStatus({ preview: preview({ freshness: "cached" }), connected: true, supported: true })).toBe("cached");
    expect(derivePreviewWorkspaceStatus({ preview: preview(), connected: false, supported: true })).toBe("offline");
    expect(derivePreviewWorkspaceStatus({ preview: preview(), connected: true, supported: false })).toBe("unsupported");
  });

  it("returns a sole authenticated preview for explicit selection", () => {
    const authenticated = preview({ previewId: "authenticated", authority: { id: "auth", label: "Personal", kind: "authenticated-profile", requiresExplicitOptIn: true } });
    const isolated = preview({ previewId: "isolated", authority: { id: "omp-session", label: "Session", kind: "isolated-session", requiresExplicitOptIn: false } });
    expect(choosePreview([authenticated, isolated], null)?.previewId).toBe("isolated");
    expect(choosePreview([authenticated], null)?.previewId).toBe("authenticated");
    expect(choosePreview([authenticated, isolated], "authenticated")?.previewId).toBe("authenticated");
    expect(defaultLaunchAuthority()).toBe("omp-session");
  });

  it("reports host-advertised action reasons and scales snapshot clicks to native coordinates", () => {
    const current = preview({ availableActions: ["navigate"] });
    const { availableActions: _availableActions, ...withoutActions } = preview();
    expect(previewActionSupport(current, "click", "ready", true, true)).toEqual({
      supported: false,
      reason: "This host does not advertise click for this preview.",
    });
    expect(previewActionSupport(withoutActions, "navigate", "ready", true, true)).toEqual({
      supported: false,
      reason: "This host does not advertise navigate for this preview.",
    });
    expect(previewActionSupport(current, "press", "ready", false, true)).toEqual({
      supported: false,
      reason: "This host does not permit browser preview control.",
    });
    expect(
      displayedToNativeCoordinate({ x: 50, y: 25 }, { width: 100, height: 50 }, { width: 1000, height: 500 }),
    ).toEqual({ x: 500, y: 250 });
  });

  it("rejects absolute and parent-traversal uploads before sending them", () => {
    expect(isProjectRelativeUploadPath("assets/image.png")).toBe(true);
    expect(isProjectRelativeUploadPath("/tmp/image.png")).toBe(false);
    expect(isProjectRelativeUploadPath("C:\\temp\\image.png")).toBe(false);
    expect(isProjectRelativeUploadPath("../image.png")).toBe(false);
  });

  it("separates preview reads from control and input grants", () => {
    expect(previewHostSupport(undefined)).toEqual({
      supported: false,
      controlSupported: false,
      inputSupported: false,
      reason: "This host does not advertise browser preview control.",
    });
    expect(
      previewHostSupport({
        grantedFeatures: ["preview.control"],
        grantedCapabilities: ["preview.read"],
      }),
    ).toEqual({ supported: true, controlSupported: false, inputSupported: false });
    expect(
      previewHostSupport({
        grantedFeatures: ["preview.control"],
        grantedCapabilities: ["preview.read", "preview.control", "preview.input"],
      }),
    ).toEqual({ supported: true, controlSupported: true, inputSupported: true });
  });

  it("keeps policy checks to allowed and safe reason fields", () => {
    expect(
      parsePreviewPolicyDecision({
        allowed: true,
        confirmationRequired: true,
        reason: "Confirm navigation",
        confirmationId: "confirmation",
        commandId: "command",
      }),
    ).toEqual({ allowed: true, reason: "Confirm navigation" });
  });
});

describe("preview desktop adapter", () => {
  it("acquires a matching cooperative lease and passes its id to mutations", async () => {
    const command = vi.fn(async (_targetId: string, intent: { command: string; args: Record<string, unknown> }) => {
      if (intent.command === "preview.lease.acquire") {
        return accepted({ previewId: identity.previewId, leaseId: "lease-a", expiresAt: Date.now() + 30_000 });
      }
      return accepted({});
    });
    const controller = { command, confirm: vi.fn() } as unknown as DesktopRuntimeController;
    const adapter = new PreviewDesktopAdapter(controller, address);

    await adapter.mutate("navigate", identity, { url: "https://example.test" });

    expect(command).toHaveBeenCalledWith(
      address.targetId,
      expect.objectContaining({
        command: "preview.navigate",
        args: expect.objectContaining({ previewId: identity.previewId, leaseId: "lease-a", url: "https://example.test" }),
      }),
    );
  });

  it("releases every cooperative lease when the workspace adapter is disposed", async () => {
    const command = vi.fn(async (_targetId: string, intent: { command: string }) => {
      if (intent.command === "preview.lease.acquire") {
        return accepted({ previewId: identity.previewId, leaseId: "lease-a", expiresAt: Date.now() + 30_000 });
      }
      return accepted({});
    });
    const adapter = new PreviewDesktopAdapter(
      { command, confirm: vi.fn() } as unknown as DesktopRuntimeController,
      address,
    );

    await adapter.mutate("navigate", identity, { url: "https://example.test" });
    await adapter.dispose();

    expect(command).toHaveBeenCalledWith(
      address.targetId,
      expect.objectContaining({ command: "preview.lease.release" }),
    );
  });

  it("distinguishes capture release from lease release", async () => {
    const command = vi.fn(async (_targetId: string, intent: { command: string }) => {
      if (intent.command === "preview.lease.acquire") {
        return accepted({ previewId: identity.previewId, leaseId: "lease-a", expiresAt: Date.now() + 30_000 });
      }
      return accepted({});
    });
    const adapter = new PreviewDesktopAdapter(
      { command, confirm: vi.fn() } as unknown as DesktopRuntimeController,
      address,
    );

    await adapter.mutate("navigate", identity, { url: "https://example.test" });
    command.mockClear();

    // releaseCapture should not trigger a lease release command
    adapter.releaseCapture(identity);
    expect(command).not.toHaveBeenCalledWith(
      address.targetId,
      expect.objectContaining({ command: "preview.lease.release" }),
    );

    // release should trigger the lease release command
    await adapter.release(identity);
    expect(command).toHaveBeenCalledWith(
      address.targetId,
      expect.objectContaining({ command: "preview.lease.release" }),
    );
  });

  it("routes a projected preview confirmation through the controller", async () => {
    const confirm = vi.fn(async () => ({ accepted: true }));
    const adapter = new PreviewDesktopAdapter(
      { command: vi.fn(), confirm } as unknown as DesktopRuntimeController,
      address,
    );
    const challenge = {
      confirmationId: "confirmation-a" as never,
      commandId: "command-a" as never,
      hostId: identity.hostId as never,
      sessionId: identity.sessionId as never,
      summary: "preview.navigate",
    };

    await adapter.confirm(challenge, "approve");

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationId: "confirmation-a",
        commandId: "command-a",
        decision: "approve",
      }),
    );
  });

  it("rejects absolute upload paths before acquiring a lease", async () => {
    const command = vi.fn();
    const adapter = new PreviewDesktopAdapter(
      { command, confirm: vi.fn() } as unknown as DesktopRuntimeController,
      address,
    );

    await expect(adapter.mutate("upload", identity, { selector: "input", path: "/tmp/file.png" })).rejects.toThrow(
      "project-relative",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("releases object URLs when a capture is replaced or disposed", async () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    png[19] = 1;
    png[23] = 1;
    const revoked: string[] = [];
    const resource = new PreviewCaptureResource({
      read: async (_preview, captureId, offset) => ({
        previewId: identity.previewId,
        captureId,
        size: png.byteLength,
        offset,
        nextOffset: png.byteLength,
        complete: true,
        content: Buffer.from(png).toString("base64"),
      }),
      sha256: async () => "a".repeat(64),
      createObjectURL: () => "blob:preview",
      revokeObjectURL: (url) => revoked.push(url),
    });
    const capture = {
      captureId: "capture-a",
      mimeType: "image/png" as const,
      size: png.byteLength,
      width: 1,
      height: 1,
      capturedAt: 1,
      sha256: "a".repeat(64),
    };

    await resource.objectUrl(identity, capture);
    resource.release(identity);

    expect(revoked).toEqual(["blob:preview"]);
  });
});
