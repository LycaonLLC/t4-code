import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  CI_TRIGGER_CAPABILITY,
  CLUSTER_OPERATOR_FEATURE,
  hostId,
  sessionId,
  type CiRunArguments,
  type ClusterSessionCreateArguments,
  type ClusterWorkspaceCreateArguments,
  type Revision,
} from "@t4-code/protocol";

export type ClusterOperation = "read" | "manage" | "ci";

export interface ClusterOperatorAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export function clusterOperatorAvailability(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  operation: ClusterOperation,
  expectedRevision?: Revision,
): ClusterOperatorAvailability {
  if (snapshot.clusterOperatorEnabled !== true) {
    return { enabled: false, reason: "Cluster operator is disabled in this app." };
  }
  if (snapshot.connections.get(targetId) !== "connected") {
    return { enabled: false, reason: "Reconnect this host to inspect cluster workspaces." };
  }
  const hostIdValue = snapshot.targetHosts.get(targetId);
  const host = hostIdValue === undefined ? undefined : snapshot.hosts.get(hostIdValue);
  if (host === undefined || !host.grantedFeatures.includes(CLUSTER_OPERATOR_FEATURE)) {
    return { enabled: false, reason: "This host does not advertise cluster operator support." };
  }
  if (!host.grantedCapabilities.includes("sessions.read")) {
    return { enabled: false, reason: "This host did not grant session read access." };
  }
  if (operation !== "read" && !host.grantedCapabilities.includes("sessions.manage")) {
    return {
      enabled: false,
      reason: "This host did not grant workspace and session management.",
    };
  }
  if (operation === "ci" && !host.grantedCapabilities.includes(CI_TRIGGER_CAPABILITY)) {
    return { enabled: false, reason: "This host did not grant CI trigger access." };
  }
  if (operation === "ci" && expectedRevision === undefined) {
    return { enabled: false, reason: "Waiting for the latest session revision." };
  }
  return { enabled: true };
}

function requireAvailability(
  controller: DesktopRuntimeController,
  targetId: string,
  operation: ClusterOperation,
  expectedRevision?: Revision,
): void {
  const availability = clusterOperatorAvailability(
    controller.getSnapshot(),
    targetId,
    operation,
    expectedRevision,
  );
  if (!availability.enabled) throw new Error(availability.reason);
}

export async function createClusterWorkspace(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  args: ClusterWorkspaceCreateArguments,
) {
  requireAvailability(controller, targetId, "manage");
  const result = await controller.command(targetId, {
    hostId: hostId(hostIdValue),
    command: "workspace.create",
    args,
  });
  if (!result.accepted) throw new Error("Cluster workspace creation was rejected.");
  return result;
}

export async function createClusterSession(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  args: ClusterSessionCreateArguments,
) {
  requireAvailability(controller, targetId, "manage");
  const result = await controller.command(targetId, {
    hostId: hostId(hostIdValue),
    command: "session.create",
    args,
  });
  if (!result.accepted) throw new Error("Cluster session creation was rejected.");
  return result;
}

export async function runClusterCi(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  sessionIdValue: string,
  expectedRevision: Revision,
  args: CiRunArguments,
) {
  requireAvailability(controller, targetId, "ci", expectedRevision);
  const result = await controller.command(targetId, {
    hostId: hostId(hostIdValue),
    sessionId: sessionId(sessionIdValue),
    command: "ci.run",
    expectedRevision,
    args,
  });
  if (!result.accepted) throw new Error("CI run was rejected.");
  return result;
}
