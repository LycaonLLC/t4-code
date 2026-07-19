import {
  PreviewCaptureResource,
  PreviewLeaseManager,
  type DesktopRuntimeController,
  type PreviewCaptureMetadata,
  type PreviewCaptureReadResult,
  type PreviewIdentity,
} from "@t4-code/client";
import { hostId, sessionId, type CommandId, type ConfirmationId, type HostId, type SessionId } from "@t4-code/protocol";
import type { CommandIntent, CommandResult } from "@t4-code/protocol/desktop-ipc";

import type { LiveSessionAddress } from "../../platform/live-workspace.ts";
import {
  isProjectRelativeUploadPath,
  parsePreviewPolicyDecision,
  type PreviewAction,
  type PreviewPolicyDecision,
} from "./preview-model.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureReadResult(value: unknown): PreviewCaptureReadResult {
  if (!isRecord(value)) {
    throw new Error("The host returned an invalid preview capture chunk.");
  }
  const record = value;
  if (
    typeof record.previewId !== "string" ||
    typeof record.captureId !== "string" ||
    typeof record.size !== "number" ||
    typeof record.offset !== "number" ||
    typeof record.nextOffset !== "number" ||
    typeof record.complete !== "boolean" ||
    typeof record.content !== "string"
  ) {
    throw new Error("The host returned an invalid preview capture chunk.");
  }
  return {
    previewId: record.previewId,
    captureId: record.captureId,
    size: record.size,
    offset: record.offset,
    nextOffset: record.nextOffset,
    complete: record.complete,
    content: record.content,
  };
}

function commandError(result: CommandResult, command: string): Error {
  const error = new Error(result.error?.message ?? `The host rejected ${command}.`);
  Object.assign(error, { code: result.error?.code ?? "REJECTED" });
  return error;
}

/**
 * The renderer's narrow browser-preview authority boundary. It exposes only
 * host/session scoped commands and keeps pixels plus cooperative leases local
 * to this window; browser/profile state never crosses into T4.
 */
export class PreviewDesktopAdapter {
  readonly captures: PreviewCaptureResource;
  readonly leases: PreviewLeaseManager;
  private readonly controller: DesktopRuntimeController;
  readonly address: LiveSessionAddress;


  constructor(controller: DesktopRuntimeController, address: LiveSessionAddress) {
    this.controller = controller;
    this.address = address;
    this.captures = new PreviewCaptureResource({
      read: async (identity, captureId, offset) =>
        captureReadResult(
          await this.command("preview.capture.read", identity, { captureId, offset }),
        ),
    });
    this.leases = new PreviewLeaseManager({
      previewLeaseAcquire: async (identity, ttlMs) =>
        this.leaseResponse(await this.command("preview.lease.acquire", identity, { ...(ttlMs === undefined ? {} : { ttlMs }) })),
      previewLeaseRenew: async (identity, ttlMs) =>
        this.leaseResponse(
          await this.command("preview.lease.renew", identity, {
            leaseId: identity.leaseId,
            ...(ttlMs === undefined ? {} : { ttlMs }),
          }),
        ),
      previewLeaseRelease: async (identity) =>
        this.leaseResponse(await this.command("preview.lease.release", identity, { leaseId: identity.leaseId })),
    });
  }

  async launch(url: string, authorityId = "omp-session"): Promise<void> {
    await this.command("preview.launch", undefined, { url, authorityId });
  }

  async policy(
    action: PreviewAction,
    identity: PreviewIdentity | undefined,
    url?: string,
  ): Promise<PreviewPolicyDecision> {
    const result = await this.command("preview.policy.check", identity, {
      action,
      ...(url === undefined ? {} : { url }),
    });
    return parsePreviewPolicyDecision(result);
  }

  async mutate(
    action: PreviewAction,
    identity: PreviewIdentity,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    if (action === "upload" && !isProjectRelativeUploadPath(String(args.path ?? ""))) {
      throw new Error("Choose a project-relative upload path.");
    }
    await this.leases.mutate(identity, async (leaseId) => {
      await this.command(`preview.${action}`, { ...identity, leaseId }, args);
    });
  }

  async objectUrl(identity: PreviewIdentity, capture: PreviewCaptureMetadata): Promise<string> {
    return this.captures.objectUrl(identity, capture);
  }

  async confirm(
    challenge: {
      readonly confirmationId: ConfirmationId;
      readonly commandId: CommandId;
      readonly hostId: HostId;
      readonly sessionId?: SessionId;
    },
    decision: "approve" | "deny",
  ): Promise<void> {
    const result = await this.controller.confirm({
      targetId: this.address.targetId,
      ...challenge,
      decision,
    });
    if (!result.accepted) throw new Error("The host rejected the preview confirmation.");
  }

  async release(identity: PreviewIdentity): Promise<void> {
    this.captures.release(identity);
    await this.leases.release(identity);
  }

  async dispose(): Promise<void> {
    this.captures.dispose();
    await this.leases.releaseAll();
  }

  private async command(
    command: string,
    identity: (PreviewIdentity & { readonly leaseId?: string }) | undefined,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const result = await this.controller.command(this.address.targetId, {
      hostId: hostId(this.address.hostId),
      sessionId: sessionId(this.address.sessionId),
      command,
      args: {
        ...(identity === undefined ? {} : { previewId: identity.previewId }),
        ...(identity?.leaseId === undefined ? {} : { leaseId: identity.leaseId }),
        ...args,
      },
    } as CommandIntent);
    if (!result.accepted) throw commandError(result, command);
    return result.result;
  }

  private leaseResponse(result: unknown): unknown {
    return { ok: true, result };
  }
}
