import { StyleSheet, Text, View } from "react-native";

import type { CompanionConnectionState } from "@/runtime/companion-runtime";
import { colors, radius, spacing } from "@/theme";

export function ConnectionPill({ connection, label }: { connection: CompanionConnectionState; label?: string }) {
  const connected = connection === "ready";
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: connected ? colors.green : colors.amber }]} />
      <Text numberOfLines={1} style={styles.label}>{connected ? `Live · ${label ?? "T4"}` : "Reconnecting"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { maxWidth: 170, height: 30, flexDirection: "row", alignItems: "center", gap: spacing.xs, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.sm },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { flexShrink: 1, color: colors.textMuted, fontSize: 12, fontWeight: "600" },
});
