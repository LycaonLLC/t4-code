import { fail } from "./errors.js";
import { controlFree } from "./guards.js";
import { MAX_ID_BYTES } from "./limits.js";

export type HostId = string & { readonly __hostId: unique symbol };
export type SessionId = string & { readonly __sessionId: unique symbol };
export type ProjectId = string & { readonly __projectId: unique symbol };
export type EntryId = string & { readonly __entryId: unique symbol };
export type AgentId = string & { readonly __agentId: unique symbol };
export type TerminalId = string & { readonly __terminalId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };
export type CommandId = string & { readonly __commandId: unique symbol };
export type PairingId = string & { readonly __pairingId: unique symbol };
export type ConfirmationId = string & { readonly __confirmationId: unique symbol };
export type Revision = string & { readonly __revision: unique symbol };
export type WatchId = string & { readonly __watchId: unique symbol };
export type LeaseId = string & { readonly __leaseId: unique symbol };
export type OperationId = string & { readonly __operationId: unique symbol };
export type PreviewId = string & { readonly __previewId: unique symbol };
export type PreviewCaptureId = string & { readonly __previewCaptureId: unique symbol };
export type CatalogId = string & { readonly __catalogId: unique symbol };
export type DeviceId = string & { readonly __deviceId: unique symbol };
export type ImageId = string & { readonly __imageId: unique symbol };
export type ArtifactId = string & { readonly __artifactId: unique symbol };
export type TurnId = string & { readonly __turnId: unique symbol };

export function id<T extends string>(value: unknown, path: string): T {
	return controlFree(value, path, MAX_ID_BYTES) as T;
}
export const hostId = (v: unknown, p = "hostId"): HostId => id<HostId>(v, p);
export const sessionId = (v: unknown, p = "sessionId"): SessionId => id<SessionId>(v, p);
export const projectId = (v: unknown, p = "projectId"): ProjectId => id<ProjectId>(v, p);
export const entryId = (v: unknown, p = "entryId"): EntryId => id<EntryId>(v, p);
export const agentId = (v: unknown, p = "agentId"): AgentId => id<AgentId>(v, p);
export const terminalId = (v: unknown, p = "terminalId"): TerminalId => id<TerminalId>(v, p);
export const requestId = (v: unknown, p = "requestId"): RequestId => id<RequestId>(v, p);
export const commandId = (v: unknown, p = "commandId"): CommandId => id<CommandId>(v, p);
export const pairingId = (v: unknown, p = "pairingId"): PairingId => id<PairingId>(v, p);
export const confirmationId = (v: unknown, p = "confirmationId"): ConfirmationId => id<ConfirmationId>(v, p);
export const watchId = (v: unknown, p = "watchId"): WatchId => id<WatchId>(v, p);
export const leaseId = (v: unknown, p = "leaseId"): LeaseId => id<LeaseId>(v, p);
export const operationId = (v: unknown, p = "operationId"): OperationId => id<OperationId>(v, p);
export const previewId = (v: unknown, p = "previewId"): PreviewId => id<PreviewId>(v, p);
export const previewCaptureId = (v: unknown, p = "captureId"): PreviewCaptureId => id<PreviewCaptureId>(v, p);
export const catalogId = (v: unknown, p = "catalogId"): CatalogId => id<CatalogId>(v, p);
export const deviceId = (v: unknown, p = "deviceId"): DeviceId => id<DeviceId>(v, p);
export const imageId = (value: unknown, path = "imageId"): ImageId => {
	const result = controlFree(value, path, 36);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result))
		fail("INVALID_FRAME", "expected an opaque image identifier", path);
	return result as ImageId;
};
export const artifactId = (value: unknown, path = "artifactId"): ArtifactId => {
	const result = controlFree(value, path, 64);
	if (!/^[0-9]+$/u.test(result)) fail("INVALID_FRAME", "expected a numeric opaque artifact identifier", path);
	return result as ArtifactId;
};
export const turnId = (v: unknown, p = "turnId"): TurnId => id<TurnId>(v, p);
export const revision = (v: unknown, p = "revision"): Revision => id<Revision>(v, p);
export interface SessionKey {
	readonly hostId: HostId;
	readonly sessionId: SessionId;
}
export function sameSession(a: SessionKey, b: SessionKey): boolean {
	return a.hostId === b.hostId && a.sessionId === b.sessionId;
}
