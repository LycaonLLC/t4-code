import type { ProviderTransportState } from "@t4-code/protocol";

export type ProviderTransportTone = "good" | "warn" | "quiet";

export interface ProviderTransportPresentation {
  readonly transport: string;
  readonly status: string;
  readonly tone: ProviderTransportTone;
  readonly policy: string;
  readonly reuse: string;
  readonly payload: string;
  readonly connection: string;
}

export interface ProviderTransportDiagnosticReport {
  readonly kind: "t4-code.provider-transport";
  readonly version: 1;
  readonly provider: ProviderTransportState["provider"];
  readonly configuredPolicy: ProviderTransportState["configuredPolicy"];
  readonly lastTransport?: ProviderTransportState["lastTransport"];
  readonly websocketPreferred: boolean;
  readonly websocketDisabled: boolean;
  readonly websocketConnected: boolean;
  readonly fallbackCount: number;
  readonly canAppend: boolean;
  readonly prewarmed: boolean;
  readonly hasSessionState: boolean;
  readonly hasTurnState: boolean;
  readonly fullContextRequests: number;
  readonly deltaRequests: number;
  readonly inputJsonBytes: number;
  readonly lastInputJsonBytes?: number;
}

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatDiagnosticBytes(bytes: number): string {
  if (bytes < 1_024) return `${INTEGER.format(bytes)} B`;
  if (bytes < 1_048_576) return `${INTEGER.format(bytes / 1_024)} KB`;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(bytes / 1_048_576)} MB`;
}

export function presentProviderTransport(
  state: ProviderTransportState,
): ProviderTransportPresentation {
  const transport =
    state.lastTransport === "websocket"
      ? "WebSocket"
      : state.lastTransport === "sse"
        ? "SSE"
        : "Waiting";
  const fallbackLabel = `${INTEGER.format(state.fallbackCount)} fallback${state.fallbackCount === 1 ? "" : "s"}`;
  const status =
    state.lastTransport === undefined
      ? "No request yet"
      : state.fallbackCount > 0
        ? fallbackLabel
        : state.websocketConnected
          ? "Connected"
          : state.lastTransport === "sse"
            ? "Streaming"
            : "Idle";
  const tone: ProviderTransportTone =
    state.lastTransport === undefined
      ? "quiet"
      : state.fallbackCount > 0
        ? "warn"
        : state.websocketDisabled
          ? "quiet"
        : "good";
  const policy =
    state.configuredPolicy === "auto"
      ? "Automatic"
      : state.configuredPolicy === "on"
        ? "WebSocket on"
        : "WebSocket off";
  const payload = `${formatDiagnosticBytes(state.inputJsonBytes)} total${
    state.lastInputJsonBytes === undefined
      ? ""
      : ` · ${formatDiagnosticBytes(state.lastInputJsonBytes)} last`
  }`;
  const connection =
    state.configuredPolicy === "off"
      ? "WebSocket disabled by policy"
      : state.websocketDisabled && state.fallbackCount > 0
        ? "WebSocket disabled after fallback"
        : state.websocketDisabled
          ? "WebSocket unavailable"
    : state.websocketConnected
      ? "Live socket connected"
      : state.prewarmed
        ? "Socket prewarmed"
        : "No live socket";

  return {
    transport,
    status,
    tone,
    policy,
    reuse: `${INTEGER.format(state.deltaRequests)} delta · ${INTEGER.format(state.fullContextRequests)} full`,
    payload,
    connection,
  };
}

/**
 * Copy only the provider's bounded, redacted counters. Keeping this as an
 * explicit allowlist prevents future session or request fields from silently
 * entering a support report when the wire contract grows.
 */
export function buildProviderTransportReport(
  state: ProviderTransportState,
): string {
  const report: ProviderTransportDiagnosticReport = {
    kind: "t4-code.provider-transport",
    version: 1,
    provider: state.provider,
    configuredPolicy: state.configuredPolicy,
    ...(state.lastTransport === undefined ? {} : { lastTransport: state.lastTransport }),
    websocketPreferred: state.websocketPreferred,
    websocketDisabled: state.websocketDisabled,
    websocketConnected: state.websocketConnected,
    fallbackCount: state.fallbackCount,
    canAppend: state.canAppend,
    prewarmed: state.prewarmed,
    hasSessionState: state.hasSessionState,
    hasTurnState: state.hasTurnState,
    fullContextRequests: state.fullContextRequests,
    deltaRequests: state.deltaRequests,
    inputJsonBytes: state.inputJsonBytes,
    ...(state.lastInputJsonBytes === undefined
      ? {}
      : { lastInputJsonBytes: state.lastInputJsonBytes }),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
