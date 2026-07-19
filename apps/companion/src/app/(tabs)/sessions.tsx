import { Redirect, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConnectionPill } from "@/components/connection-pill";
import { SessionRow } from "@/components/session-row";
import { useCompanionRuntime } from "@/runtime/companion-runtime";
import { projectName, sessionsFrom } from "@/runtime/session-view";
import { colors, radius, spacing } from "@/theme";

export default function SessionsScreen() {
  const runtime = useCompanionRuntime();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessionsFrom(runtime.projection).filter((session) =>
      session.archivedAt === undefined &&
      (needle === "" || session.title.toLowerCase().includes(needle) || projectName(session).toLowerCase().includes(needle)),
    );
  }, [query, runtime.projection]);
  if (runtime.host === null || runtime.connection === "pairing") return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.heading}>Sessions</Text>
        <ConnectionPill connection={runtime.connection} />
      </View>
      <TextInput
        autoCapitalize="none"
        clearButtonMode="while-editing"
        onChangeText={setQuery}
        placeholder="Search sessions and projects"
        placeholderTextColor={colors.textDim}
        style={styles.search}
        value={query}
      />
      <FlatList
        contentContainerStyle={sessions.length === 0 ? styles.emptyList : styles.list}
        data={sessions}
        keyExtractor={(session) => `${String(session.hostId)}:${String(session.sessionId)}`}
        ListEmptyComponent={<Text style={styles.empty}>No matching sessions.</Text>}
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            onPress={() => {
              void runtime.openSession(item).catch(() => undefined);
              router.push({ pathname: "/session/[id]", params: { id: String(item.sessionId) } });
            }}
          />
        )}
        style={styles.listFrame}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md },
  header: { minHeight: 72, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: -1 },
  search: { height: 44, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: spacing.md, fontSize: 15, marginBottom: spacing.md },
  listFrame: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, overflow: "hidden" },
  list: { paddingBottom: spacing.xl },
  emptyList: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: colors.textMuted, fontSize: 14 },
});
