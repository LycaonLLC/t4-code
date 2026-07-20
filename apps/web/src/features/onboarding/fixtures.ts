// Deterministic onboarding fixtures: one named fixture per listed host,
// service, and pairing state, all derived from a fixed epoch so screenshots
// and tests are byte-identical across loads. Everything here is a safe
// display label — no addresses, ports, socket paths, unit paths, or tokens
// (the one wire fixture that carries a token exists to prove the renderer
// strips it).
import type { OnboardingState } from "./flow.ts";
import { createOnboarding } from "./flow.ts";
import type { HostConnectionState, HostRow } from "./hosts.ts";
import type { PairedDevice, WirePairResult } from "./model.ts";
import {
  deviceRequested,
  identityMismatch,
  issueCode,
  PAIRING_IDLE,
  type PairingPhase,
  type PairingRequest,
} from "./pairing.ts";
import { initialService, type ServiceStatus, type ServiceViewModel } from "./service.ts";

/** Fixed fixture epoch shared by every timestamp below. */
export const ONBOARDING_EPOCH_MS = Date.UTC(2026, 6, 11, 9, 30, 0);

function minutesAgo(minutes: number): string {
  return new Date(ONBOARDING_EPOCH_MS - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Service

export const SERVICE_FIXTURES: Readonly<Record<ServiceStatus, ServiceViewModel>> = {
  checking: initialService("systemd"),
  "not-installed": {
    platform: "systemd",
    status: "not-installed",
    version: null,
    detail: "No systemd user service is installed for the T4 host yet.",
    diagnostics: [],
  },
  installing: {
    platform: "systemd",
    status: "installing",
    version: null,
    detail: "Installing the systemd user service…",
    diagnostics: [],
  },
  "install-failed": {
    platform: "systemd",
    status: "install-failed",
    version: null,
    detail: "The service could not be installed: systemd refused the unit (exit 1).",
    diagnostics: [
      "systemctl --user daemon-reload exited with code 1",
      "12 journal lines captured from the attempt",
      "Last attempt 11 Jul 2026, 09:28",
    ],
  },
  stopped: {
    platform: "systemd",
    status: "stopped",
    version: null,
    detail: "The systemd user service is installed but not running.",
    diagnostics: [],
  },
  starting: {
    platform: "systemd",
    status: "starting",
    version: null,
    detail: "Starting the T4 host…",
    diagnostics: [],
  },
  "start-failed": {
    platform: "systemd",
    status: "start-failed",
    version: null,
    detail: "The T4 host exited right after starting (exit 101).",
    diagnostics: [
      "Service entered failed state after 2 restarts",
      "T4 host log ended with: address already in use",
      "Last attempt 11 Jul 2026, 09:29",
    ],
  },
  running: {
    platform: "systemd",
    status: "running",
    version: "0.3.0",
    detail: "T4 host 0.3.0 is running as a systemd user service.",
    diagnostics: [],
  },
};

/** The same running state on a Mac, for launchd copy proof. */
export const SERVICE_RUNNING_LAUNCHD: ServiceViewModel = {
  platform: "launchd",
  status: "running",
  version: "0.3.0",
  detail: "T4 host 0.3.0 is running as a launchd agent.",
  diagnostics: [],
};

// ---------------------------------------------------------------------------
// Hosts

export const HOST_FIXTURES: Readonly<Record<HostConnectionState, HostRow>> = {
  starting: {
    id: "host-local",
    kind: "local",
    name: "This computer",
    identity: null,
    state: "starting",
    reason: "The T4 host is up; waiting for it to finish loading sessions.",
    sessionCount: null,
    protocolLabel: null,
  },
  ready: {
    id: "host-local-ready",
    kind: "local",
    name: "This computer",
    identity: null,
    state: "ready",
    reason: "Connected. 12 sessions across 3 projects.",
    sessionCount: 12,
    protocolLabel: "omp-app/1 · 0.3",
  },
  unavailable: {
    id: "host-mac-unavailable",
    kind: "remote",
    name: "macbook-pro",
    identity: { account: "maintainer@github", node: "studio-mac" },
    state: "unavailable",
    reason: "The host did not answer. It may be asleep, or its T4 host service is stopped.",
    sessionCount: null,
    protocolLabel: null,
  },
  reconnecting: {
    id: "host-mac-reconnecting",
    kind: "remote",
    name: "macbook-pro",
    identity: { account: "maintainer@github", node: "studio-mac" },
    state: "reconnecting",
    reason: "Connection dropped 40 seconds ago. Retrying — attempt 3.",
    sessionCount: 8,
    protocolLabel: "omp-app/1 · 0.3",
  },
  "offline-cache": {
    id: "host-mac-offline",
    kind: "remote",
    name: "macbook-pro",
    identity: { account: "maintainer@github", node: "studio-mac" },
    state: "offline-cache",
    reason: "Offline since 08:12. Showing the last state it sent — nothing here is live.",
    sessionCount: 8,
    protocolLabel: "omp-app/1 · 0.3",
  },
  "version-skew": {
    id: "host-linux-skew",
    kind: "remote",
    name: "build-linux",
    identity: { account: "maintainer@github", node: "build-linux" },
    state: "version-skew",
    reason: "This computer runs an older T4 host (0.2). Sessions work; terminals and file previews stay off until it updates.",
    sessionCount: 21,
    protocolLabel: "omp-app/1 · 0.2",
  },
  "upgrade-required": {
    id: "host-linux-upgrade",
    kind: "remote",
    name: "build-linux",
    identity: { account: "maintainer@github", node: "build-linux" },
    state: "upgrade-required",
    reason: "This host speaks a newer protocol (omp-app/2) than this app understands. Update the app to connect.",
    sessionCount: null,
    protocolLabel: "omp-app/2",
  },
  "read-only": {
    id: "host-mac-readonly",
    kind: "remote",
    name: "macbook-pro",
    identity: { account: "maintainer@github", node: "studio-mac" },
    state: "read-only",
    reason: "Your pairing grants viewing only. Someone on the host can widen it from there.",
    sessionCount: 8,
    protocolLabel: "omp-app/1 · 0.3",
  },
};

/** The grouped menu scenario: local ready plus a remote in every state. */
export const HOST_MENU_FIXTURE: readonly HostRow[] = [
  HOST_FIXTURES.ready,
  HOST_FIXTURES.reconnecting,
  HOST_FIXTURES["offline-cache"],
  HOST_FIXTURES["version-skew"],
  HOST_FIXTURES["upgrade-required"],
  HOST_FIXTURES["read-only"],
  HOST_FIXTURES.unavailable,
];

// ---------------------------------------------------------------------------
// Pairing

export const PAIRING_REQUEST_FIXTURE: PairingRequest = {
  deviceLabel: "MacBook Pro",
  platform: "macos",
  identity: { account: "maintainer@github", node: "studio-mac" },
  requested: ["observe", "control", "shell"],
};

/**
 * Wire pairing result including the bearer token the renderer must never
 * surface. Tests serialize renderer state and assert this exact string is
 * absent.
 */
export const WIRE_PAIR_RESULT_FIXTURE: WirePairResult = {
  deviceId: "device-mbp",
  deviceLabel: "MacBook Pro",
  platform: "macos",
  account: "maintainer@github",
  node: "studio-mac",
  pairedAt: minutesAgo(0),
  capabilities: ["observe", "control"],
  token: "FIXTURE-BEARER-TOKEN-DO-NOT-RENDER",
};

const CODE_ISSUED = issueCode(PAIRING_IDLE, "739 214", ONBOARDING_EPOCH_MS);

export const PAIRING_FIXTURES: Readonly<Record<string, PairingPhase>> = {
  idle: PAIRING_IDLE,
  "code-issued": CODE_ISSUED,
  "capability-review": deviceRequested(CODE_ISSUED, PAIRING_REQUEST_FIXTURE),
  expired: { kind: "expired", attemptsLeft: 4 },
  exhausted: { kind: "expired", attemptsLeft: 0 },
  "identity-mismatch": identityMismatch(
    { account: "maintainer@github", node: "studio-mac" },
    { account: "intruder@example", node: "unknown-node" },
  ),
  "capability-denied": {
    kind: "capability-denied",
    deviceLabel: "MacBook Pro",
    refused: ["observe", "control", "shell"],
  },
  revoked: { kind: "revoked", deviceLabel: "MacBook Pro" },
};

// ---------------------------------------------------------------------------
// Devices

export const DEVICE_FIXTURES: readonly PairedDevice[] = [
  {
    id: "device-mbp",
    label: "MacBook Pro",
    platform: "macos",
    identity: { account: "maintainer@github", node: "studio-mac" },
    pairedAt: minutesAgo(60 * 24 * 12),
    lastSeenAt: minutesAgo(4),
    capabilities: ["observe", "control", "shell"],
    connected: true,
  },
  {
    id: "device-phone",
    label: "Work phone",
    platform: "android",
    identity: { account: "maintainer@github", node: "work-phone" },
    pairedAt: minutesAgo(60 * 24 * 3),
    lastSeenAt: minutesAgo(60 * 26),
    capabilities: ["observe"],
    connected: false,
  },
  {
    id: "device-work",
    label: "Field laptop",
    platform: "linux",
    identity: { account: "maintainer@github", node: "field-laptop" },
    pairedAt: minutesAgo(60 * 24 * 40),
    lastSeenAt: null,
    capabilities: ["observe", "control", "files", "destructive"],
    connected: false,
  },
];

// ---------------------------------------------------------------------------
// Flow scenarios

export const ONBOARDING_SCENARIOS: Readonly<Record<string, OnboardingState>> = {
  "runtime-checking": createOnboarding(SERVICE_FIXTURES.checking),
  "runtime-missing": createOnboarding(SERVICE_FIXTURES["not-installed"]),
  "runtime-failed": createOnboarding(SERVICE_FIXTURES["start-failed"]),
  "runtime-running": createOnboarding(SERVICE_FIXTURES.running),
  hosts: {
    ...createOnboarding(SERVICE_FIXTURES.running, [HOST_FIXTURES.ready]),
    stage: "hosts",
  },
  "hosts-empty-remote-only": {
    ...createOnboarding(SERVICE_FIXTURES["not-installed"]),
    stage: "hosts",
    remoteOnly: true,
  },
  defaults: {
    ...createOnboarding(SERVICE_FIXTURES.running, [HOST_FIXTURES.ready]),
    stage: "defaults",
    defaults: { defaultProject: "t4-code", resume: "resume-last" },
  },
};

/** Projects offered on the defaults stage; safe display labels only. */
export const DEFAULT_PROJECT_CHOICES: readonly string[] = [
  "t4-code",
  "notes-app",
  "web-client",
];
