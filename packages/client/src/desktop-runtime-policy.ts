import { DesktopRuntimeError, asRecord } from "./desktop-runtime-contracts.ts";
import type {
  DesktopControllerLease,
  DesktopControllerLeaseAcquireResult,
} from "./desktop-runtime-contracts.ts";

export const DEFAULT_MAX_RUNTIME_ERRORS = 32;

export interface DesktopControllerLeaseEntry {
  readonly key: string;
  readonly lease?: DesktopControllerLease;
  readonly pending?: Promise<DesktopControllerLeaseAcquireResult>;
}

export function boundedText(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

export function leasePayload(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return asRecord(record.result) ?? record;
}

export function commandFailure(error: unknown, fallback: string): DesktopRuntimeError {
  const record = asRecord(error);
  const code = boundedText(record?.code);
  if (code === "outcome_unknown") return new DesktopRuntimeError("outcome_unknown", "request outcome is unknown; inspect host state before retrying");
  if (code === "stale" || code === "revision_conflict" || code === "conflict") return new DesktopRuntimeError("stale", fallback);
  return new DesktopRuntimeError("command", error instanceof Error ? error.message : fallback);
}
