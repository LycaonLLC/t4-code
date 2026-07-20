import {
  hostId,
  revision,
  sessionId,
  type SessionRef,
} from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  OMP_RUNTIME_INTEGRATION,
  ProjectionStore,
  deriveAttentionInbox,
  readSessionAttention,
  type DesktopHostMetadata,
  type DesktopRuntimeSnapshot,
  type ProjectionFrame,
  type ProjectionSnapshot,
} from "../src/index.ts";

const V = "omp-app/1" as const;
const NOW = Date.parse("2030-01-02T12:00:00.000Z");

function attentionRef(
  host: string,
  session: string,
  attention: unknown,
  updatedAt = "2030-01-02T11:00:00.000Z",
): SessionRef {
  return {
    hostId: hostId(host),
    sessionId: sessionId(session),
    project: { projectId: `project-${host}` as never, name: `Project ${host}` },
    revision: revision(`revision-${host}-${session}`),
    title: `Session ${session}`,
    status: "idle",
    updatedAt,
    attention,
  } as unknown as SessionRef;
}

function validAttention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pending: [],
    pendingCount: 0,
    truncated: false,
    ...overrides,
  };
}

function sessionFrame(refs: readonly SessionRef[]): ProjectionFrame {
  return {
    v: V,
    type: "sessions",
    cursor: { epoch: "attention-index", seq: 1 },
    sessions: refs,
    totalCount: refs.length,
    truncated: false,
  } as ProjectionFrame;
}

function hostMetadata(targetId: string, host: string): DesktopHostMetadata {
  return {
    targetId,
    hostId: host,
    ompVersion: "test",
    ompBuild: "test",
    appserverVersion: "test",
    appserverBuild: "test",
    epoch: "attention-index",
    grantedCapabilities: ["sessions.read", "sessions.prompt"],
    grantedFeatures: [],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
}

function runtimeSnapshot(
  refs: readonly SessionRef[],
  options: {
    readonly mutateProjection?: (store: ProjectionStore) => void;
    readonly projection?: ProjectionSnapshot;
    readonly disconnectedHosts?: ReadonlySet<string>;
  } = {},
): DesktopRuntimeSnapshot {
  let projection = options.projection;
  if (projection === undefined) {
    const store = new ProjectionStore();
    store.applyPublicFrame(sessionFrame(refs));
    options.mutateProjection?.(store);
    projection = store.getSnapshot();
  }
  const hosts = [...new Set(refs.map((ref) => String(ref.hostId)))];
  return {
    version: 1,
    integration: OMP_RUNTIME_INTEGRATION,
    platform: "darwin",
    desktopVersion: "test",
    startState: "started",
    targets: new Map(hosts.map((host) => [
      `target-${host}`,
      {
        targetId: `target-${host}`,
        label: host,
        kind: "remote" as const,
        state: options.disconnectedHosts?.has(host) ? "disconnected" as const : "connected" as const,
        paired: true,
      },
    ])),
    connections: new Map(hosts.map((host) => [
      `target-${host}`,
      options.disconnectedHosts?.has(host) ? "disconnected" as const : "connected" as const,
    ])),
    targetHosts: new Map(hosts.map((host) => [`target-${host}`, host])),
    hosts: new Map(hosts.map((host) => [host, hostMetadata(`target-${host}`, host)])),
    catalogs: new Map(),
    settings: new Map(),
    projection,
    runtimeErrors: [],
  };
}

describe("readSessionAttention", () => {
  it("distinguishes absent state from a malformed or future shape", () => {
    expect(readSessionAttention({ sessionId: "legacy" })).toEqual({ status: "absent" });
    expect(readSessionAttention({ attention: { ...validAttention(), future: true } })).toEqual({
      status: "malformed",
    });
    expect(readSessionAttention({
      attention: validAttention({
        pending: [{
          kind: "question",
          id: "question-1",
          question: "Which fixture?",
          options: [{ id: "a", label: "A" }],
          allowText: true,
          requestedAt: "2030-01-02T10:00:00.000Z",
        }],
        pendingCount: 1,
      }),
    })).toMatchObject({ status: "valid", value: { pendingCount: 1 } });
  });

  it("fails the whole summary closed for duplicate requests and broken truncation math", () => {
    const duplicate = {
      kind: "approval",
      id: "same-request",
      title: "Approval",
      summary: "Approve this",
      requestedAt: "2030-01-02T10:00:00.000Z",
    };
    expect(readSessionAttention({
      attention: validAttention({ pending: [duplicate, duplicate], pendingCount: 2 }),
    })).toEqual({ status: "malformed" });
    expect(readSessionAttention({
      attention: validAttention({ pendingCount: 1, truncated: false }),
    })).toEqual({ status: "malformed" });
  });
});

describe("deriveAttentionInbox", () => {
  it("derives attention from more than eight indexed sessions without warming them", () => {
    const refs = Array.from({ length: 12 }, (_, index) => attentionRef(
      "host-many",
      `session-${index}`,
      validAttention({
        pending: [{
          kind: "approval",
          id: `approval-${index}`,
          title: `Approval ${index}`,
          summary: "Needs a decision",
          requestedAt: `2030-01-02T${String(index).padStart(2, "0")}:00:00.000Z`,
        }],
        pendingCount: 1,
      }),
    ));
    const snapshot = runtimeSnapshot(refs);
    const projection = deriveAttentionInbox(snapshot, { now: NOW });

    expect(snapshot.projection.sessions.size).toBeLessThanOrEqual(8);
    expect(snapshot.projection.sessionIndex.size).toBe(12);
    expect(projection.groups.needsYou).toHaveLength(12);
    expect(new Set(projection.items.map((item) => item.key)).size).toBe(12);
  });

  it("keeps identical raw session and request ids distinct across hosts", () => {
    const pending = {
      kind: "plan",
      id: "shared-request",
      title: "Review plan",
      summary: "Plan is ready",
      requestedAt: "2030-01-02T10:00:00.000Z",
    };
    const snapshot = runtimeSnapshot([
      attentionRef("host-a", "shared-session", validAttention({ pending: [pending], pendingCount: 1 })),
      attentionRef("host-b", "shared-session", validAttention({ pending: [pending], pendingCount: 1 })),
    ]);
    const items = deriveAttentionInbox(snapshot, { now: NOW }).groups.needsYou;

    expect(items).toHaveLength(2);
    expect(items[0]?.identity.hostId).not.toBe(items[1]?.identity.hostId);
    expect(items[0]?.key).not.toBe(items[1]?.key);
  });

  it("orders expiring confirmations first, then oldest pending, and newest outcomes", () => {
    const refs = [
      attentionRef("host-order", "pending-new", validAttention({
        pending: [{
          kind: "approval",
          id: "new",
          title: "New",
          summary: "New approval",
          requestedAt: "2030-01-02T11:00:00.000Z",
        }],
        pendingCount: 1,
        latestOutcome: {
          id: "done-new",
          kind: "completed",
          at: "2030-01-02T11:30:00.000Z",
          summary: "Finished recently",
        },
      })),
      attentionRef("host-order", "pending-old", validAttention({
        pending: [{
          kind: "question",
          id: "old",
          question: "Old question",
          options: [],
          allowText: true,
          requestedAt: "2030-01-02T09:00:00.000Z",
        }],
        pendingCount: 1,
        latestOutcome: {
          id: "done-old",
          kind: "completed",
          at: "2030-01-02T08:00:00.000Z",
          summary: "Finished earlier",
        },
      })),
    ];
    const snapshot = runtimeSnapshot(refs, {
      mutateProjection: (store) => {
        store.applyPublicFrame({
          v: V,
          type: "confirmation",
          confirmationId: "confirm-first" as never,
          commandId: "command-first" as never,
          hostId: hostId("host-order"),
          sessionId: sessionId("pending-new"),
          commandHash: "hash",
          revision: revision("revision-host-order-pending-new"),
          expiresAt: "2030-01-02T12:00:30.000Z",
          summary: "Confirm command",
        });
      },
    });
    const projection = deriveAttentionInbox(snapshot, { now: NOW });

    expect(projection.groups.needsYou.map((item) => item.kind === "confirmation" ? item.confirmationId : item.requestId))
      .toEqual(["confirm-first", "old", "new"]);
    expect(projection.groups.done.map((item) => item.outcomeId)).toEqual(["done-new", "done-old"]);
  });

  it("deduplicates a replay by stable identity and tracks seen outcomes without hiding them", () => {
    const ref = attentionRef("host-replay", "session-replay", validAttention({
      latestOutcome: {
        id: "outcome-1",
        kind: "failed",
        at: "2030-01-02T11:00:00.000Z",
        summary: "Exited with code 1",
      },
    }));
    const snapshot = runtimeSnapshot([ref]);
    const first = deriveAttentionInbox(snapshot, { now: NOW });
    const second = deriveAttentionInbox(snapshot, { now: NOW });
    const key = first.groups.problems[0]!.key;
    const seen = deriveAttentionInbox(snapshot, { now: NOW, seenOutcomeKeys: new Set([key]) });

    expect(second.items.map((item) => item.key)).toEqual(first.items.map((item) => item.key));
    expect(seen.groups.problems).toHaveLength(1);
    expect(seen.groups.problems[0]?.seen).toBe(true);
    expect(seen.urgentCount).toBe(0);
  });

  it("drops expired confirmations and disables a still-live challenge when its revision is stale", () => {
    const ref = attentionRef("host-confirm", "session-confirm", validAttention());
    const snapshot = runtimeSnapshot([ref], {
      mutateProjection: (store) => {
        for (const [id, expiresAt, itemRevision] of [
          ["expired", "2030-01-02T11:59:59.000Z", "revision-host-confirm-session-confirm"],
          ["stale", "2030-01-02T12:00:30.000Z", "older-revision"],
        ] as const) {
          store.applyPublicFrame({
            v: V,
            type: "confirmation",
            confirmationId: id as never,
            commandId: `command-${id}` as never,
            hostId: hostId("host-confirm"),
            sessionId: sessionId("session-confirm"),
            commandHash: `hash-${id}`,
            revision: revision(itemRevision),
            expiresAt,
            summary: `${id} challenge`,
          });
        }
      },
    });
    const confirmations = deriveAttentionInbox(snapshot, { now: NOW }).groups.needsYou;

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      kind: "confirmation",
      confirmationId: "stale",
      actionability: { available: false, reason: "item-replaced" },
    });
  });

  it("reports malformed, legacy, truncated, and count-mismatched inventory as partial", () => {
    const valid = attentionRef("host-partial", "valid", validAttention({
      pending: [{
        kind: "approval",
        id: "visible",
        title: "Visible",
        summary: "Visible request",
        requestedAt: "2030-01-02T10:00:00.000Z",
      }],
      pendingCount: 3,
      truncated: true,
    }));
    const legacy = attentionRef("host-partial", "legacy", undefined) as unknown as Record<string, unknown>;
    delete legacy.attention;
    const malformed = attentionRef("host-partial", "malformed", { pending: "wrong" });
    const initial = runtimeSnapshot([valid, legacy as unknown as SessionRef, malformed]);
    const projection = {
      ...initial.projection,
      sessionIndexMetadata: new Map([[
        "host-partial",
        { totalCount: 4, truncated: false },
      ]]),
    } as ProjectionSnapshot;
    const snapshot = runtimeSnapshot([], { projection });
    const inbox = deriveAttentionInbox(snapshot, { now: NOW });

    expect(inbox.inventory.partial).toBe(true);
    expect(inbox.inventory.omittedPendingCount).toBe(2);
    expect(new Set(inbox.inventory.issues.map((issue) => issue.reason))).toEqual(new Set([
      "inventory-count-mismatch",
      "attention-truncated",
      "attention-unavailable",
      "attention-malformed",
    ]));
    expect(inbox.urgentCount).toBe(3);
  });

  it("keeps offline pending work visible but fails its inline action closed", () => {
    const ref = attentionRef("host-offline", "session-offline", validAttention({
      pending: [{
        kind: "question",
        id: "question-offline",
        question: "Can I continue?",
        options: [],
        allowText: true,
        requestedAt: "2030-01-02T10:00:00.000Z",
      }],
      pendingCount: 1,
    }));
    const snapshot = runtimeSnapshot([ref], { disconnectedHosts: new Set(["host-offline"]) });
    const item = deriveAttentionInbox(snapshot, { now: NOW }).groups.needsYou[0];

    expect(item).toMatchObject({
      kind: "question",
      actionability: { available: false, reason: "host-disconnected" },
    });
  });
});
