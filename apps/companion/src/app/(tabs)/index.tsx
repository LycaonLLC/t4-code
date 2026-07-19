import { Redirect, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AttentionRow } from "@/components/attention-row";
import { ConnectionPill } from "@/components/connection-pill";
import { SessionRow } from "@/components/session-row";
import { useCompanionRuntime } from "@/runtime/companion-runtime";
import { attentionFrom, sessionsFrom } from "@/runtime/session-view";
import { colors, radius, spacing } from "@/theme";

export default function InboxScreen() {
  const router = useRouter();
  const runtime = useCompanionRuntime();
  const [refreshing, setRefreshing] = useState(false);
  const attention = useMemo(() => attentionFrom(runtime.projection), [runtime.projection]);
  const sessions = useMemo(
    () => sessionsFrom(runtime.projection).filter((session) => session.archivedAt === undefined && session.status === "active").slice(0, 5),
    [runtime.projection],
  );
  if (runtime.host === null || runtime.connection === "pairing") return <Redirect href="/" />;

  const open = (sessionId: string) => {
    const session = sessionsFrom(runtime.projection).find((item) => String(item.sessionId) === sessionId);
    if (session !== undefined) void runtime.openSession(session).catch(() => undefined);
    router.push({ pathname: "/session/[id]", params: { id: sessionId } });
  };
  const refresh = async () => {
    setRefreshing(true);
    try { await runtime.refresh(); } catch { /* surfaced by the shared runtime */ }
    finally { setRefreshing(false); }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.blue} onRefresh={() => void refresh()} />}
      >
        <View style={styles.header}>
          <Text style={styles.heading}>Needs you</Text>
          <ConnectionPill connection={runtime.connection} label={runtime.host.label.replace("T4 on ", "")} />
        </View>
        {runtime.error !== null && (
          <Text onPress={runtime.retry} style={styles.error}>{runtime.error} Tap to retry.</Text>
        )}

        <Text style={styles.sectionTitle}>Needs your attention</Text>
        <View style={styles.group}>
          {attention.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyTitle}>Nothing is waiting</Text><Text style={styles.emptyBody}>Questions and approvals from your active work will appear here.</Text></View>
          ) : attention.map((item) => <AttentionRow attention={item} key={item.key} onPress={() => open(String(item.session.sessionId))} />)}
        </View>

        <Text style={styles.sectionTitle}>Running</Text>
        <View style={styles.group}>
          {sessions.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyTitle}>No sessions running</Text><Text style={styles.emptyBody}>Start work from OMP or T4 Code on your computer.</Text></View>
          ) : sessions.map((session) => <SessionRow key={`${String(session.hostId)}:${String(session.sessionId)}`} session={session} onPress={() => open(String(session.sessionId))} />)}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  header: { minHeight: 72, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  heading: { color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: -1 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: spacing.lg, marginBottom: spacing.sm },
  group: { overflow: "hidden", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  empty: { padding: spacing.lg, gap: spacing.xs },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  emptyBody: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.red, backgroundColor: "#251416", borderRadius: radius.sm, padding: spacing.sm, fontSize: 13, lineHeight: 18 },
});
