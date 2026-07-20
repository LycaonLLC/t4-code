import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
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

import { AttentionNotificationState } from "./attention-notification-state";
import { useCompanionRuntime } from "./companion-runtime";
import { attentionFrom } from "./session-view";

const NOTIFICATIONS_STORAGE_KEY = "t4-companion.attention-notifications.v1";
const ATTENTION_CHANNEL_ID = "attention";

export type AttentionNotificationStatus = "loading" | "disabled" | "enabled" | "denied" | "unavailable" | "error";

interface AttentionNotificationsValue {
  readonly status: AttentionNotificationStatus;
  readonly error: string | null;
  readonly setEnabled: (enabled: boolean) => Promise<boolean>;
}

const AttentionNotificationsContext = createContext<AttentionNotificationsValue | null>(null);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function prepareNotifications(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ATTENTION_CHANNEL_ID, {
    name: "Agent attention",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
  });
}

function notificationError(caught: unknown): string {
  return caught instanceof Error && caught.message.trim() !== ""
    ? caught.message
    : "Notifications are unavailable on this device.";
}

export function AttentionNotificationsProvider({ children }: PropsWithChildren) {
  const runtime = useCompanionRuntime();
  const router = useRouter();
  const [status, setStatus] = useState<AttentionNotificationStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const tracker = useRef(new AttentionNotificationState());
  const hostKey = runtime.host?.endpointKey ?? null;
  const attention = useMemo(() => attentionFrom(runtime.projection), [runtime.projection]);

  useEffect(() => {
    if (Platform.OS === "web") {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    void SecureStore.getItemAsync(NOTIFICATIONS_STORAGE_KEY)
      .then(async (stored) => {
        if (cancelled) return;
        if (stored !== "enabled") {
          setStatus("disabled");
          return;
        }
        await prepareNotifications();
        const permission = await Notifications.getPermissionsAsync();
        if (!cancelled) setStatus(permission.granted ? "enabled" : "denied");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(notificationError(caught));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    tracker.current.reset();
  }, [hostKey]);

  useEffect(() => {
    if (runtime.connection !== "ready") return;
    const added = tracker.current.update(attention);
    if (status !== "enabled" || AppState.currentState === "active" || added.length === 0) return;

    void Promise.all(added.map((item) => Notifications.scheduleNotificationAsync({ content: {
      title: "T4 needs your attention",
      body: "Open T4 Companion to review it.",
      data: { sessionId: String(item.session.sessionId) },
    }, trigger: null }))).catch((caught: unknown) => {
      setError(notificationError(caught));
      setStatus("error");
    });
  }, [attention, runtime.connection, status]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const sessionId = response.notification.request.content.data?.sessionId;
      if (typeof sessionId === "string" && sessionId !== "") {
        router.push({ pathname: "/session/[id]", params: { id: sessionId } });
      }
    });
    return () => subscription.remove();
  }, [router]);

  const setEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    setError(null);
    if (!enabled) {
      await SecureStore.deleteItemAsync(NOTIFICATIONS_STORAGE_KEY);
      setStatus("disabled");
      return true;
    }
    if (Platform.OS === "web") {
      setStatus("unavailable");
      return false;
    }
    try {
      await prepareNotifications();
      const current = await Notifications.getPermissionsAsync();
      const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
      if (!permission.granted) {
        setStatus("denied");
        return false;
      }
      await SecureStore.setItemAsync(NOTIFICATIONS_STORAGE_KEY, "enabled", {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      setStatus("enabled");
      return true;
    } catch (caught) {
      setError(notificationError(caught));
      setStatus("error");
      return false;
    }
  }, []);

  const value = useMemo<AttentionNotificationsValue>(() => ({ status, error, setEnabled }), [status, error, setEnabled]);
  return <AttentionNotificationsContext.Provider value={value}>{children}</AttentionNotificationsContext.Provider>;
}

export function useAttentionNotifications(): AttentionNotificationsValue {
  const value = useContext(AttentionNotificationsContext);
  if (value === null) throw new Error("useAttentionNotifications must be used inside AttentionNotificationsProvider");
  return value;
}
