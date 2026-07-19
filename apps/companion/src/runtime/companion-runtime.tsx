import {
  createOmpClient,
  createProjectionStore,
  isConfirmationDecisionConsumed,
  type OmpClient,
  type OmpClientError,
  type OmpClientState,
  type ProjectionSnapshot,
  type Unsubscribe,
} from "@t4-code/client";
import {
  ADDITIVE_FEATURES,
  DEVICE_CAPABILITIES,
  type PendingAttentionItem,
  type SessionRef,
} from "@t4-code/protocol";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState, Platform } from "react-native";

import { parseCompanionHost, type CompanionHost } from "./backend";
import { NativeWebSocketTransport } from "./native-websocket-transport";
import { applySessionListInventory } from "./session-inventory";
import { canWriteSession, warmSession } from "./session-view";

// Secure Store keys are intentionally portable across iOS and Android. iOS
// rejects colons even though browser storage commonly accepts them.
const HOST_STORAGE_KEY = "t4-companion.host.v1";
const COMPATIBILITY_FEATURES = ADDITIVE_FEATURES.filter(
  (feature) => feature !== "prompt.images" && feature !== "transcript.images",
);

export type CompanionConnectionState = "loading" | OmpClientState;

interface RuntimeValue {
  readonly host: CompanionHost | null;
  readonly connection: CompanionConnectionState;
  readonly error: string | null;
  readonly hostId: string | null;
  readonly projection: ProjectionSnapshot;
  readonly configureHost: (address: string, profileId?: string) => Promise<void>;
  readonly forgetHost: () => Promise<void>;
  readonly retry: () => void;
  readonly pair: (code: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly openSession: (session: SessionRef) => Promise<void>;
  readonly sendMessage: (session: SessionRef, message: string) => Promise<void>;
  readonly respond: (session: SessionRef, item: PendingAttentionItem, value?: string) => Promise<void>;
  readonly decideConfirmation: (input: {
    session: SessionRef;
    confirmationId: string;
    commandId: string;
    decision: "approve" | "deny";
  }) => Promise<void>;
}

const initialProjection = createProjectionStore().snapshot;
const RuntimeContext = createContext<RuntimeValue | null>(null);

async function loadStoredHost(): Promise<CompanionHost | null> {
  const raw = await SecureStore.getItemAsync(HOST_STORAGE_KEY);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Partial<CompanionHost>;
  if (
    parsed.version !== 1 ||
    typeof parsed.origin !== "string" ||
    typeof parsed.profileId !== "string" ||
    typeof parsed.deviceId !== "string"
  ) {
    throw new Error("The saved host is damaged. Add it again.");
  }
  return parseCompanionHost(parsed.origin, parsed.profileId, {
    deviceId: parsed.deviceId,
    ...(typeof parsed.deviceToken === "string" ? { deviceToken: parsed.deviceToken } : {}),
  });
}

async function saveStoredHost(host: CompanionHost): Promise<void> {
  await SecureStore.setItemAsync(HOST_STORAGE_KEY, JSON.stringify(host), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

function publicError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "T4 could not complete that action.";
}

export function CompanionRuntimeProvider({ children }: PropsWithChildren) {
  const [host, setHost] = useState<CompanionHost | null>(null);
  const [connection, setConnection] = useState<CompanionConnectionState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionSnapshot>(initialProjection);
  const clientRef = useRef<OmpClient | null>(null);
  const projectionRef = useRef(createProjectionStore({ maxWarmSessions: 12 }));
  const liveHostRef = useRef<CompanionHost | null>(null);
  const liveHostIdRef = useRef<string | null>(null);
  const refreshGenerationRef = useRef(-1);

  const refreshWith = useCallback(async (client: OmpClient, currentHostId: string) => {
    if (client.state !== "ready") return;
    const response = await client.command({ hostId: currentHostId, command: "session.list", args: {} });
    if (!response.ok) throw new Error(response.error?.message ?? "T4 could not load sessions.");
    const cursor = applySessionListInventory(projectionRef.current, currentHostId, response.result);
    await client.command({ hostId: currentHostId, command: "host.watch", args: { cursor } });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadStoredHost()
      .then((stored) => {
        if (cancelled) return;
        liveHostRef.current = stored;
        setHost(stored);
        setConnection(stored === null ? "idle" : "connecting");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(publicError(caught));
        setConnection("idle");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => projectionRef.current.subscribe(setProjection), []);

  useEffect(() => {
    if (host === null) return;
    let disposed = false;
    const unsubscribes: Unsubscribe[] = [];
    const transportFactory = async () => {
      const transport = new NativeWebSocketTransport(host.wsUrl);
      await transport.open();
      return transport;
    };
    const client = createOmpClient({
      transport: transportFactory,
      projection: projectionRef.current,
      capabilities: DEVICE_CAPABILITIES,
      requestedFeatures: ADDITIVE_FEATURES,
      compatibilityRequestedFeatures: COMPATIBILITY_FEATURES,
      authentication: () =>
        liveHostRef.current?.deviceToken === undefined
          ? undefined
          : {
              deviceId: liveHostRef.current.deviceId,
              deviceToken: liveHostRef.current.deviceToken,
            },
      privilegedPairResult: async (result) => {
        const current = liveHostRef.current;
        if (current === null || current.endpointKey !== host.endpointKey) {
          throw new Error("The selected host changed during pairing.");
        }
        const paired = Object.freeze({ ...current, deviceId: result.deviceId, deviceToken: result.deviceToken });
        await saveStoredHost(paired);
        liveHostRef.current = paired;
        setHost(paired);
      },
      client: {
        name: "T4 Companion",
        version: "0.1.28",
        build: "expo-57",
        platform: Platform.OS,
      },
      reconnect: { baseMs: 300, maxMs: 10_000 },
    });
    clientRef.current = client;
    refreshGenerationRef.current = -1;
    unsubscribes.push(
      client.onEvent((event) => {
        if (event.kind !== "welcome") return;
        const nextHostId = String(event.payload.hostId);
        liveHostIdRef.current = nextHostId;
        setHostId(nextHostId);
        if (event.payload.authentication !== "pairing-required" && client.state === "ready") {
          refreshGenerationRef.current = client.snapshot().generation;
          void refreshWith(client, nextHostId).catch((caught: unknown) => setError(publicError(caught)));
        }
      }),
      client.onState((snapshot) => {
        if (disposed) return;
        setConnection(snapshot.state);
        if (snapshot.state === "ready") setError(null);
        if (
          snapshot.state === "ready" &&
          liveHostIdRef.current !== null &&
          refreshGenerationRef.current !== snapshot.generation
        ) {
          refreshGenerationRef.current = snapshot.generation;
          void refreshWith(client, liveHostIdRef.current).catch((caught: unknown) => setError(publicError(caught)));
        }
      }),
      client.onError((caught: OmpClientError) => {
        if (!disposed) setError(caught.message);
      }),
    );
    void client.connect().catch((caught: unknown) => {
      if (!disposed) setError(publicError(caught));
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") client.wake();
    });
    return () => {
      disposed = true;
      appState.remove();
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (clientRef.current === client) clientRef.current = null;
      void client.close();
    };
  }, [host, refreshWith]);

  const configureHost = useCallback(async (address: string, profileId?: string) => {
    const next = parseCompanionHost(address, profileId, liveHostRef.current ?? undefined);
    await saveStoredHost(next);
    liveHostRef.current = next;
    liveHostIdRef.current = null;
    setHostId(null);
    setError(null);
    setConnection("connecting");
    setHost(next);
  }, []);

  const forgetHost = useCallback(async () => {
    await SecureStore.deleteItemAsync(HOST_STORAGE_KEY);
    liveHostRef.current = null;
    liveHostIdRef.current = null;
    setHost(null);
    setHostId(null);
    setError(null);
    setConnection("idle");
  }, []);

  const retry = useCallback(() => {
    setError(null);
    clientRef.current?.reconnectNow();
  }, []);

  const refresh = useCallback(async () => {
    const client = clientRef.current;
    const currentHostId = liveHostIdRef.current;
    if (client === null || currentHostId === null) throw new Error("T4 is not connected yet.");
    await refreshWith(client, currentHostId);
  }, [refreshWith]);

  const pair = useCallback(async (code: string) => {
    const client = clientRef.current;
    const current = liveHostRef.current;
    if (client === null || current === null) throw new Error("T4 is not ready to pair.");
    await client.pairStart({
      code: code.trim(),
      deviceId: current.deviceId,
      deviceName: Platform.OS === "ios" ? "T4 Companion on iPhone" : "T4 Companion on Android",
      platform: Platform.OS,
      requestedCapabilities: DEVICE_CAPABILITIES,
    });
  }, []);

  const openSession = useCallback(async (session: SessionRef) => {
    const client = clientRef.current;
    if (client === null || client.state !== "ready") throw new Error("T4 is reconnecting.");
    projectionRef.current.activateSession(String(session.hostId), String(session.sessionId));
    const response = await client.attach(String(session.hostId), String(session.sessionId));
    if (!response.ok) throw new Error(response.error?.message ?? "T4 could not open that session.");
  }, []);

	const sendMessage = useCallback(async (session: SessionRef, message: string) => {
    const client = clientRef.current;
    const text = message.trim();
    if (text === "") return;
    if (client === null || client.state !== "ready") throw new Error("T4 is reconnecting.");
		const attached = warmSession(
			projectionRef.current.snapshot,
			String(session.hostId),
			String(session.sessionId),
		);
		if (!canWriteSession(session, attached !== undefined))
			throw new Error("This session is active in another app and is read-only here.");
    const command = session.status === "active" ? "session.steer" : "session.prompt";
    const response = await client.command({
      hostId: String(session.hostId),
      sessionId: String(session.sessionId),
      command,
      expectedRevision: String(session.revision),
      args: { message: text },
    });
    if (!response.ok) throw new Error(response.error?.message ?? "T4 did not accept that message.");
  }, []);

	const respond = useCallback(async (session: SessionRef, item: PendingAttentionItem, value?: string) => {
    const client = clientRef.current;
    if (client === null || client.state !== "ready") throw new Error("T4 is reconnecting.");
		const attached = warmSession(
			projectionRef.current.snapshot,
			String(session.hostId),
			String(session.sessionId),
		);
		if (!canWriteSession(session, attached !== undefined))
			throw new Error("This session is active in another app and is read-only here.");
    const args: Record<string, unknown> = { requestId: item.id };
    if (item.kind === "question") args.value = value?.trim() ?? "";
    else args.confirmed = value !== "deny";
    const response = await client.command({
      hostId: String(session.hostId),
      sessionId: String(session.sessionId),
      command: "session.ui.respond",
      expectedRevision: String(session.revision),
      args,
    });
    if (!response.ok) throw new Error(response.error?.message ?? "T4 did not accept that response.");
  }, []);

  const decideConfirmation = useCallback(async ({ session, ...decision }: {
    session: SessionRef;
    confirmationId: string;
    commandId: string;
    decision: "approve" | "deny";
  }) => {
    const client = clientRef.current;
    if (client === null || client.state !== "ready") throw new Error("T4 is reconnecting.");
    const response = await client.confirm({
      ...decision,
      hostId: String(session.hostId),
      sessionId: String(session.sessionId),
    });
    if (!isConfirmationDecisionConsumed(response)) throw new Error("That confirmation is no longer current.");
  }, []);

  const value = useMemo<RuntimeValue>(() => ({
    host,
    connection,
    error,
    hostId,
    projection,
    configureHost,
    forgetHost,
    retry,
    pair,
    refresh,
    openSession,
    sendMessage,
    respond,
    decideConfirmation,
  }), [host, connection, error, hostId, projection, configureHost, forgetHost, retry, pair, refresh, openSession, sendMessage, respond, decideConfirmation]);

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useCompanionRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("useCompanionRuntime must be used inside CompanionRuntimeProvider");
  return value;
}
