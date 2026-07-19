import { Pressable, StyleSheet, Text, View } from "react-native";

import type { CompanionAttentionItem } from "@/runtime/session-view";
import { projectName, relativeTime } from "@/runtime/session-view";
import { colors, spacing } from "@/theme";

export function AttentionRow({ attention, onPress }: { attention: CompanionAttentionItem; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.badge}><Text style={styles.badgeText}>{attention.item.kind === "question" ? "?" : "✓"}</Text></View>
      <View style={styles.copy}>
        <View style={styles.topline}>
          <Text style={styles.title}>{attention.title}</Text>
          <Text style={styles.time}>{relativeTime(new Date(attention.requestedAtMs).toISOString())}</Text>
        </View>
        <Text numberOfLines={1} style={styles.summary}>{attention.summary}</Text>
        <Text style={styles.project}>{projectName(attention.session)}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 86, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { backgroundColor: colors.surfaceRaised },
  badge: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: colors.amber, alignItems: "center", justifyContent: "center" },
  badgeText: { color: colors.amber, fontSize: 17, fontWeight: "800" },
  copy: { flex: 1, gap: 3 },
  topline: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  title: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  summary: { color: colors.textMuted, fontSize: 14 },
  project: { color: colors.textDim, fontSize: 12 },
  time: { color: colors.amber, fontSize: 12 },
  chevron: { color: colors.textDim, fontSize: 24 },
});
