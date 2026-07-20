/**
 * Product-facing runtime vocabulary.
 *
 * This boundary sits above OMP's wire protocol. OMP remains the complete,
 * first-party runtime; a future integration describes only the T4 features it
 * can actually support.
 */

export const OMP_RUNTIME_KIND = "omp" as const;

/** Additions to this union are deliberate product decisions, not wire changes. */
export type RuntimeKind = typeof OMP_RUNTIME_KIND | (string & {});

export type RuntimeIntegrationLevel = "first-party" | "integrated" | "observed";

export interface RuntimeIntegrationDescriptor {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  readonly level: RuntimeIntegrationLevel;
}

export const OMP_RUNTIME_INTEGRATION: RuntimeIntegrationDescriptor = Object.freeze({
  kind: OMP_RUNTIME_KIND,
  displayName: "OMP",
  level: "first-party",
});

export const T4_RUNTIME_FEATURES = Object.freeze({
  sessionInventory: "session.inventory",
  sessionCreate: "session.create",
  sessionPrompt: "session.prompt",
  sessionCancel: "session.cancel",
  transcriptReplay: "transcript.replay",
  approvals: "approvals",
  agentTree: "agent.tree",
  files: "files",
  terminal: "terminal",
  browser: "browser",
  settings: "settings",
  usage: "usage",
  handoff: "handoff",
} as const);

export type KnownRuntimeFeature =
  (typeof T4_RUNTIME_FEATURES)[keyof typeof T4_RUNTIME_FEATURES];
export type RuntimeFeature = KnownRuntimeFeature | (string & {});

export type RuntimeFeatureSupport =
  | { readonly status: "available" }
  | { readonly status: "read-only"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export type RuntimeFeatureMap = Readonly<
  Partial<Record<RuntimeFeature, RuntimeFeatureSupport>>
>;

export interface RuntimeIdentity {
  readonly runtimeKind: RuntimeKind;
  readonly targetId: string;
  readonly hostId?: string;
  readonly sessionId?: string;
}

function identityPart(value: string, name: string): string {
  if (value.length === 0) throw new Error(`runtime identity ${name} cannot be empty`);
  return `${value.length}:${value}`;
}

/**
 * Collision-safe key for caches, routes, notifications, and cross-runtime
 * search results. Length prefixes keep embedded separators unambiguous.
 */
export function runtimeIdentityKey(identity: RuntimeIdentity): string {
  const parts = [
    identityPart(identity.runtimeKind, "kind"),
    identityPart(identity.targetId, "targetId"),
  ];
  if (identity.hostId !== undefined) parts.push(identityPart(identity.hostId, "hostId"));
  if (identity.sessionId !== undefined) {
    if (identity.hostId === undefined) {
      throw new Error("runtime identity sessionId requires hostId");
    }
    parts.push(identityPart(identity.sessionId, "sessionId"));
  }
  return parts.join("|");
}

export function availableRuntimeFeature(): RuntimeFeatureSupport {
  return Object.freeze({ status: "available" });
}

export function unavailableRuntimeFeature(
  reason: string,
  status: "read-only" | "unavailable" = "unavailable",
): RuntimeFeatureSupport {
  if (reason.trim().length === 0) throw new Error("unsupported runtime feature requires a reason");
  return Object.freeze({ status, reason });
}
