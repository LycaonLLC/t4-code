import type { SessionRef } from "@t4-code/protocol";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { projectName, relativeTime } from "@/runtime/session-view";
import { colors, spacing } from "@/theme";

export function SessionRow({ session, onPress }: { session: SessionRef; onPress: () => void }) {
  const active = session.status === "active";
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.icon}><Text style={styles.iconText}>⌁</Text></View>
      <View style={styles.copy}>
        <View style={styles.topline}>
          <Text numberOfLines={1} style={styles.project}>{projectName(session)}</Text>
          <Text style={[styles.status, active && styles.active]}>{active ? "Running" : relativeTime(session.updatedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.title}>{session.title}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { backgroundColor: colors.surfaceRaised },
  icon: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  iconText: { color: colors.textMuted, fontSize: 19 },
  copy: { flex: 1, gap: 3 },
  topline: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  project: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  title: { color: colors.textMuted, fontSize: 13 },
  status: { color: colors.textDim, fontSize: 12 },
  active: { color: colors.green },
  chevron: { color: colors.textDim, fontSize: 24 },
});
