import type { OmpClientState } from "./omp-client-contracts.ts";

const LEGAL_TRANSITIONS: Readonly<Record<OmpClientState, readonly OmpClientState[]>> = {
  idle: ["connecting", "closing", "closed"],
  connecting: ["handshaking", "reconnect-wait", "fatal", "closing"],
  handshaking: ["ready", "pairing", "reconnect-wait", "fatal", "closing"],
  pairing: ["ready", "reconnect-wait", "fatal", "closing"],
  ready: ["pairing", "reconnect-wait", "fatal", "closing"],
  "reconnect-wait": ["connecting", "fatal", "closing"],
  closing: ["closed"],
  closed: [],
  fatal: ["closing", "closed"],
};

export function isLegalClientTransition(current: OmpClientState, next: OmpClientState): boolean {
  return current !== next && LEGAL_TRANSITIONS[current].includes(next);
}
