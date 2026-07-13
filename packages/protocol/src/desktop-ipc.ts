import {
  PROTOCOL_VERSION,
  decodeCommand,
  decodeConfirm,
  decodeServerFrame,
  decodeTerminalClient,
  inputObject,
  object,
  controlFree,
  type CommandFrame,
  type CommandId,
  type ConfirmationId,
  type HostId,
  type ServerFrame,
  type SessionId,
  type TerminalId,
} from "@oh-my-pi/app-wire";

export const DESKTOP_IPC_VERSION = PROTOCOL_VERSION;
export type RendererServerFrame = Exclude<ServerFrame, { type: "pair.ok" }>;
export const DESKTOP_IPC_CHANNELS = [
  "omp:targets:list",
  "omp:targets:add",
  "omp:targets:remove",
  "omp:command",
  "omp:confirm",
  "omp:terminal:input",
  "omp:terminal:resize",
  "omp:terminal:close",
  "omp:bootstrap",
  "omp:connect",
  "omp:disconnect",
  "omp:pair",
  "omp:pair-links:drain",
  "omp:service:inspect",
  "omp:service:install",
  "omp:service:start",
  "omp:service:stop",
  "omp:service:restart",
  "omp:service:uninstall",
] as const;
export type DesktopInvokeChannel = (typeof DESKTOP_IPC_CHANNELS)[number];
export const DESKTOP_IPC_EVENTS = [
  "omp:server-frame",
  "omp:connection-state",
  "omp:runtime-error",
  "omp:pair-link",
] as const;
export type DesktopEventChannel = (typeof DESKTOP_IPC_EVENTS)[number];
export type DesktopPlatform = "linux" | "darwin";
export type ConnectionState = "disconnected" | "connecting" | "connected" | "pairing-required" | "error";
export type RuntimeErrorCode = "transport" | "protocol" | "internal";
export interface BootstrapRequest {}
export type ServiceAvailabilityIssue =
  | { readonly code: "omp_incompatible"; readonly message: string }
  | { readonly code: "omp_not_found"; readonly message: string }
  | { readonly code: "service_unavailable"; readonly message: string };
export interface ServiceInspection {
  definition: "missing" | "current" | "drifted";
  service: "stopped" | "starting" | "running" | "failed" | "unknown";
  diagnostics: string;
  /** Structured desktop discovery/preparation state; absent for a real inspection. */
  issue?: ServiceAvailabilityIssue;
}
export type ServiceAction = "install" | "start" | "stop" | "restart" | "uninstall";
export interface ServiceActionRequest {}
export interface ServiceActionResult { completed: true; }
export interface BootstrapResult {
  platform: DesktopPlatform;
  version: typeof PROTOCOL_VERSION;
  connected: boolean;
  service?: ServiceInspection;
}
export interface PairLinkEvent {
  hostHint: string;
  code: string;
  issuedAt: number;
}
export interface PairLinksDrainRequest {}
export interface PairLinksDrainResult { links: readonly PairLinkEvent[]; }
export interface DesktopTarget {
  targetId: string;
  label: string;
  kind: "local" | "remote";
  state: ConnectionState;
  paired: boolean;
  mode?: "direct" | "serve";
  status?: "unknown" | "online" | "offline" | "revoked";
}
export interface TargetListRequest {}
export interface TargetListResult { targets: readonly DesktopTarget[]; }
export interface TargetAddRequest {
  target: {
    targetId: string;
    label: string;
    mode: "direct" | "serve";
    address: string;
    port: number;
    expectedHostId?: string;
    requestedCapabilities: readonly string[];
    grantedCapabilities: readonly string[];
    status: "unknown" | "online" | "offline" | "revoked";
    deviceId?: string;
    lastSeen?: number;
    autoConnect?: boolean;
  };
}
export interface TargetAddResult { target: DesktopTarget; }
export interface TargetRemoveResult { targetId: string; removed: boolean; }
export interface PairStatusResult { targetId: string; state: ConnectionState; paired: boolean; }
export interface TargetRequest {
  targetId: string;
}
export interface ConnectResult {
  targetId: string;
  state: "connecting" | "connected";
}
export interface DisconnectResult {
  targetId: string;
  state: "disconnected";
}
export interface PairRequest {
  targetId: string;
  code: string;
}
export interface PairResult {
  targetId: string;
  paired: boolean;
}
export type CommandIntent = Omit<CommandFrame, "v" | "type" | "requestId" | "commandId">;
export interface CommandRequest {
  targetId: string;
  intent: CommandIntent;
}
export interface CommandResult {
  targetId: string;
  requestId: string;
  commandId: string;
  accepted: boolean;
  result?: unknown;
}
export interface ConfirmRequest {
  targetId: string;
  confirmationId: ConfirmationId;
  commandId: CommandId;
  hostId: HostId;
  sessionId?: SessionId;
  decision: "approve" | "deny";
}
export interface ConfirmResult {
  targetId: string;
  requestId: string;
  confirmationId: ConfirmationId;
  commandId: CommandId;
  accepted: boolean;
}
export interface TerminalInputRequest {
  targetId: string;
  hostId: HostId;
  sessionId: SessionId;
  terminalId: TerminalId;
  data: string;
  encoding?: "utf8" | "base64";
}
export interface TerminalResizeRequest {
  targetId: string;
  hostId: HostId;
  sessionId: SessionId;
  terminalId: TerminalId;
  cols: number;
  rows: number;
}
export interface TerminalCloseRequest {
  targetId: string;
  hostId: HostId;
  sessionId: SessionId;
  terminalId: TerminalId;
  reason?: string;
}
export interface TerminalResult {
  targetId: string;
  accepted: boolean;
}

export interface ConnectionStateEvent {
  targetId: string;
  state: ConnectionState;
}
export interface RuntimeErrorEvent {
  targetId?: string;
  code: RuntimeErrorCode;
  message: string;
}
export interface DesktopInvokeRequestMap {
  "omp:targets:list": TargetListRequest;
  "omp:targets:add": TargetAddRequest;
  "omp:targets:remove": TargetRequest;
  "omp:command": CommandRequest;
  "omp:confirm": ConfirmRequest;
  "omp:terminal:input": TerminalInputRequest;
  "omp:terminal:resize": TerminalResizeRequest;
  "omp:terminal:close": TerminalCloseRequest;
  "omp:bootstrap": BootstrapRequest;
  "omp:connect": TargetRequest;
  "omp:disconnect": TargetRequest;
  "omp:pair": PairRequest;
  "omp:pair-links:drain": PairLinksDrainRequest;
  "omp:service:inspect": ServiceActionRequest;
  "omp:service:install": ServiceActionRequest;
  "omp:service:start": ServiceActionRequest;
  "omp:service:stop": ServiceActionRequest;
  "omp:service:restart": ServiceActionRequest;
  "omp:service:uninstall": ServiceActionRequest;
}
export interface DesktopInvokeResponseMap {
  "omp:targets:list": TargetListResult;
  "omp:targets:add": TargetAddResult;
  "omp:targets:remove": TargetRemoveResult;
  "omp:command": CommandResult;
  "omp:confirm": ConfirmResult;
  "omp:terminal:input": TerminalResult;
  "omp:terminal:resize": TerminalResult;
  "omp:terminal:close": TerminalResult;
  "omp:bootstrap": BootstrapResult;
  "omp:connect": ConnectResult;
  "omp:disconnect": DisconnectResult;
  "omp:pair": PairResult;
  "omp:pair-links:drain": PairLinksDrainResult;
  "omp:service:inspect": ServiceInspection;
  "omp:service:install": ServiceActionResult;
  "omp:service:start": ServiceActionResult;
  "omp:service:stop": ServiceActionResult;
  "omp:service:restart": ServiceActionResult;
  "omp:service:uninstall": ServiceActionResult;
}
export interface RendererServerFrameEvent {
  targetId: string;
  frame: RendererServerFrame;
}
export interface DesktopEventPayloadMap {
  "omp:server-frame": RendererServerFrameEvent;
  "omp:connection-state": ConnectionStateEvent;
  "omp:runtime-error": RuntimeErrorEvent;
  "omp:pair-link": PairLinkEvent;
}
export type DesktopInvokeRequest<C extends DesktopInvokeChannel = DesktopInvokeChannel> = {
  channel: C;
  payload: DesktopInvokeRequestMap[C];
};
export type DesktopEvent<C extends DesktopEventChannel = DesktopEventChannel> = {
  channel: C;
  payload: DesktopEventPayloadMap[C];
};

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`unknown key: ${key}`);
}
function target(value: unknown): string {
  const s = controlFree(value, "targetId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(s)) throw new Error("invalid targetId");
  return s;
}
function state(value: unknown): ConnectionState {
  if (!["disconnected", "connecting", "connected", "pairing-required", "error"].includes(value as string))
    throw new Error("invalid state");
  return value as ConnectionState;
}
function targetRecord(value: unknown): TargetAddRequest["target"] {
  const item = object(value, "target");
  exact(item, ["targetId", "label", "mode", "address", "port", "expectedHostId", "requestedCapabilities", "grantedCapabilities", "status", "deviceId", "lastSeen", "autoConnect"]);
  const mode = item.mode;
  if (mode !== "direct" && mode !== "serve") throw new Error("invalid target mode");
  const status = item.status;
  if (status !== "unknown" && status !== "online" && status !== "offline" && status !== "revoked") throw new Error("invalid target status");
  if (!Array.isArray(item.requestedCapabilities) || !Array.isArray(item.grantedCapabilities) || item.requestedCapabilities.length > 32 || item.grantedCapabilities.length > 32) throw new Error("invalid target capabilities");
  const requestedCapabilities = item.requestedCapabilities.map((value) => controlFree(value, "capability", 96));
  const grantedCapabilities = item.grantedCapabilities.map((value) => controlFree(value, "capability", 96));
  const port = item.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid target port");
  const label = controlFree(item.label, "label", 128);
  const address = controlFree(item.address, "address", 2048);
  if (item.lastSeen !== undefined && (typeof item.lastSeen !== "number" || !Number.isFinite(item.lastSeen) || item.lastSeen < 0)) throw new Error("invalid target lastSeen");
  if (item.autoConnect !== undefined && typeof item.autoConnect !== "boolean") throw new Error("invalid autoConnect");
  return {
    targetId: target(item.targetId),
    label,
    mode,
    address,
    port,
    requestedCapabilities,
    grantedCapabilities,
    status,
    ...(item.expectedHostId === undefined ? {} : { expectedHostId: controlFree(item.expectedHostId, "expectedHostId") }),
    ...(item.deviceId === undefined ? {} : { deviceId: controlFree(item.deviceId, "deviceId") }),
    ...(item.lastSeen === undefined ? {} : { lastSeen: item.lastSeen }),
    ...(item.autoConnect === undefined ? {} : { autoConnect: item.autoConnect }),
  };
}
function decodeConfirmRequest(payload: Record<string, unknown>): ConfirmRequest {
  exact(payload, ["targetId", "confirmationId", "commandId", "hostId", "sessionId", "decision"]);
  const decoded = decodeConfirm({
    v: PROTOCOL_VERSION,
    type: "confirm",
    requestId: "desktop-confirm",
    confirmationId: payload.confirmationId,
    commandId: payload.commandId,
    hostId: payload.hostId,
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    decision: payload.decision,
  });
  return {
    targetId: target(payload.targetId),
    confirmationId: decoded.confirmationId,
    commandId: decoded.commandId,
    hostId: decoded.hostId,
    ...(decoded.sessionId === undefined ? {} : { sessionId: decoded.sessionId }),
    decision: decoded.decision,
  };
}
function decodeTerminalRequest(channel: "omp:terminal:input" | "omp:terminal:resize" | "omp:terminal:close", payload: Record<string, unknown>): TerminalInputRequest | TerminalResizeRequest | TerminalCloseRequest {
  const type = channel === "omp:terminal:input" ? "terminal.input" : channel === "omp:terminal:resize" ? "terminal.resize" : "terminal.close";
  exact(payload, channel === "omp:terminal:input" ? ["targetId", "hostId", "sessionId", "terminalId", "data", "encoding"] : channel === "omp:terminal:resize" ? ["targetId", "hostId", "sessionId", "terminalId", "cols", "rows"] : ["targetId", "hostId", "sessionId", "terminalId", "reason"]);
  const decoded = decodeTerminalClient({
    v: PROTOCOL_VERSION,
    type,
    hostId: payload.hostId,
    sessionId: payload.sessionId,
    terminalId: payload.terminalId,
    ...(type === "terminal.input" ? { data: payload.data, ...(payload.encoding === undefined ? {} : { encoding: payload.encoding }) } : {}),
    ...(type === "terminal.resize" ? { cols: payload.cols, rows: payload.rows } : {}),
    ...(type === "terminal.close" && payload.reason !== undefined ? { reason: payload.reason } : {}),
  });
  const common = {
    targetId: target(payload.targetId),
    hostId: decoded.hostId,
    sessionId: decoded.sessionId,
    terminalId: decoded.terminalId,
  };
  if (decoded.type === "terminal.input") return { ...common, data: decoded.data, ...(decoded.encoding === undefined ? {} : { encoding: decoded.encoding }) };
  if (decoded.type === "terminal.resize") return { ...common, cols: decoded.cols, rows: decoded.rows };
  return { ...common, ...(decoded.reason === undefined ? {} : { reason: decoded.reason }) };
}

export function decodeDesktopInvokeRequest(input: unknown): DesktopInvokeRequest {
  const frame = inputObject(input);
  exact(frame, ["channel", "payload"]);
  if (!(DESKTOP_IPC_CHANNELS as readonly string[]).includes(frame.channel as string)) throw new Error("unknown channel");
  const channel = frame.channel as DesktopInvokeChannel;
  const payload = object(frame.payload, "payload");
  switch (channel) {
    case "omp:targets:list":
      exact(payload, []);
      return { channel, payload: {} };
    case "omp:targets:add":
      exact(payload, ["target"]);
      return { channel, payload: { target: targetRecord(payload.target) } };
    case "omp:targets:remove":
    case "omp:connect":
    case "omp:disconnect":
      exact(payload, ["targetId"]);
      return { channel, payload: { targetId: target(payload.targetId) } };
    case "omp:pair":
      exact(payload, ["targetId", "code"]);
      {
        const code = controlFree(payload.code, "code", 6);
        if (!/^\d{6}$/u.test(code)) throw new Error("invalid pairing code");
        return { channel, payload: { targetId: target(payload.targetId), code } };
      }
    case "omp:bootstrap":
    case "omp:pair-links:drain":
    case "omp:service:inspect":
    case "omp:service:install":
    case "omp:service:start":
    case "omp:service:stop":
    case "omp:service:restart":
    case "omp:service:uninstall":
      exact(payload, []);
      return { channel, payload: {} };
    case "omp:command":
      exact(payload, ["targetId", "intent"]);
      {
        const intent = object(payload.intent, "intent");
        exact(intent, ["hostId", "sessionId", "command", "expectedRevision", "confirmationId", "args"]);
        const command = decodeCommand({ v: PROTOCOL_VERSION, type: "command", requestId: "desktop-request", commandId: "desktop-command", ...intent });
        const { v, type, requestId, commandId, ...clean } = command;
        void v;
        void type;
        void requestId;
        void commandId;
        return { channel, payload: { targetId: target(payload.targetId), intent: clean } };
      }
    case "omp:confirm":
      return { channel, payload: decodeConfirmRequest(payload) };
    case "omp:terminal:input":
    case "omp:terminal:resize":
    case "omp:terminal:close":
      return { channel, payload: decodeTerminalRequest(channel, payload) };
  }
  throw new Error("unsupported desktop channel");
}
function pairLink(value: unknown): PairLinkEvent {
  const item = object(value, "pair link");
  exact(item, ["hostHint", "code", "issuedAt"]);
  const hostHint = controlFree(item.hostHint, "hostHint", 128);
  const code = controlFree(item.code, "code", 6);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(hostHint) || !/^\d{6}$/u.test(code)) throw new Error("invalid pair link");
  if (typeof item.issuedAt !== "number" || !Number.isFinite(item.issuedAt) || item.issuedAt < 0) throw new Error("invalid pair link issuedAt");
  return { hostHint, code, issuedAt: item.issuedAt };
}
export function decodeDesktopEvent(input: unknown): DesktopEvent {
  const frame = inputObject(input);
  exact(frame, ["channel", "payload"]);
  if (!(DESKTOP_IPC_EVENTS as readonly string[]).includes(frame.channel as string))
    throw new Error("unknown channel");
  const channel = frame.channel as DesktopEventChannel;
  const payload = object(frame.payload, "payload");
  if (channel === "omp:server-frame") {
    exact(payload, ["targetId", "frame"]);
    const serverFrame = decodeServerFrame(payload.frame);
    if (serverFrame.type === "pair.ok")
      throw new Error("pair credentials cannot cross renderer IPC");
    return { channel, payload: { targetId: target(payload.targetId), frame: serverFrame } };
  }
  if (channel === "omp:connection-state") {
    exact(payload, ["targetId", "state"]);
    return {
      channel,
      payload: { targetId: target(payload.targetId), state: state(payload.state) },
    };
  }
  if (channel === "omp:pair-link") return { channel, payload: pairLink(payload) };
  exact(payload, ["targetId", "code", "message"]);
  if (!["transport", "protocol", "internal"].includes(payload.code as string))
    throw new Error("invalid error code");
  const error = {
    code: payload.code as RuntimeErrorCode,
    message: controlFree(payload.message, "message", 2048),
    ...(payload.targetId === undefined ? {} : { targetId: target(payload.targetId) }),
  };
  return { channel, payload: error };
}
export const isDesktopInvokeRequest = (v: unknown): v is DesktopInvokeRequest => {
  try {
    decodeDesktopInvokeRequest(v);
    return true;
  } catch {
    return false;
  }
};
export const isDesktopEvent = (v: unknown): v is DesktopEvent => {
  try {
    decodeDesktopEvent(v);
    return true;
  } catch {
    return false;
  }
};
