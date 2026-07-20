import { Redirect, useRouter } from "expo-router";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConnectionPill } from "@/components/connection-pill";
import { useAttentionNotifications } from "@/runtime/attention-notifications";
import { useCompanionRuntime } from "@/runtime/companion-runtime";
import { colors, radius, spacing } from "@/theme";

export default function HostScreen() {
  const runtime = useCompanionRuntime();
  const notifications = useAttentionNotifications();
  const router = useRouter();
  if (runtime.host === null || runtime.connection === "pairing") return <Redirect href="/" />;
  const forget = () => Alert.alert(
    "Forget this host?",
    "The Tailnet address and paired device credential will be removed from this phone.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => void runtime.forgetHost().then(() => router.replace("/")) },
    ],
  );
  const updateNotifications = () => {
    if (notifications.status === "denied") {
      void Linking.openSettings();
      return;
    }
    void notifications.setEnabled(notifications.status !== "enabled");
  };
  const notificationLabel = notifications.status === "enabled"
    ? "Disable attention notifications"
    : notifications.status === "denied"
      ? "Open notification settings"
      : "Enable attention notifications";
  const notificationDisabled = notifications.status === "loading" || notifications.status === "unavailable";
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}><Text style={styles.heading}>Host</Text><ConnectionPill connection={runtime.connection} /></View>
      <View style={styles.card}>
        <Text style={styles.hostName}>{runtime.host.label}</Text>
        <Text selectable style={styles.address}>{runtime.host.origin}</Text>
        <View style={styles.row}><Text style={styles.key}>Profile</Text><Text style={styles.value}>{runtime.host.profileId}</Text></View>
        <View style={styles.row}><Text style={styles.key}>Connection</Text><Text style={[styles.value, runtime.connection === "ready" && styles.live]}>{runtime.connection === "ready" ? "Live" : "Reconnecting"}</Text></View>
      </View>
      {runtime.error !== null && <Text style={styles.error}>{runtime.error}</Text>}
      <Pressable onPress={runtime.retry} style={styles.button}><Text style={styles.buttonLabel}>Reconnect now</Text></Pressable>
      <Pressable disabled={notificationDisabled} onPress={updateNotifications} style={[styles.secondaryButton, notificationDisabled && styles.disabled]}>
        <Text style={styles.secondaryLabel}>{notificationLabel}</Text>
      </Pressable>
      {notifications.status === "enabled" && <Text style={styles.hint}>Best-effort alerts appear while the app remains connected in the background. iOS can suspend direct Tailnet connections.</Text>}
      {notifications.status === "denied" && <Text style={styles.hint}>Allow notifications in system settings, then return here.</Text>}
      {notifications.error !== null && <Text style={styles.error}>{notifications.error}</Text>}
      <Pressable onPress={forget} style={styles.dangerButton}><Text style={styles.dangerLabel}>Forget this host</Text></Pressable>
      <Text style={styles.footnote}>T4 Companion reaches this computer only through its private Tailscale address. Funnel is not supported.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md },
  header: { minHeight: 72, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: -1 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  hostName: { color: colors.text, fontSize: 18, fontWeight: "700" },
  address: { color: colors.textMuted, fontSize: 13 },
  row: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  key: { color: colors.textMuted, fontSize: 14 },
  value: { color: colors.text, fontSize: 14, fontWeight: "600" },
  live: { color: colors.green },
  button: { height: 50, borderRadius: radius.md, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", marginTop: spacing.lg },
  buttonLabel: { color: "white", fontSize: 16, fontWeight: "700" },
  secondaryButton: { height: 50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", marginTop: spacing.sm },
  secondaryLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  dangerButton: { height: 50, borderRadius: radius.md, borderWidth: 1, borderColor: "#5d2a2d", alignItems: "center", justifyContent: "center", marginTop: spacing.sm },
  dangerLabel: { color: colors.red, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  error: { color: colors.red, fontSize: 13, lineHeight: 18, marginTop: spacing.md },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.xs },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 18, marginTop: spacing.lg },
});
