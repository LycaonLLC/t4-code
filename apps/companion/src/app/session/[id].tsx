import type { PendingAttentionItem, SessionRef } from "@t4-code/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useCompanionRuntime } from "@/runtime/companion-runtime";
import {
  canWriteSession,
  entryRole,
  entryText,
  projectName,
  sessionsFrom,
  warmSession,
} from "@/runtime/session-view";
import { colors, radius, spacing } from "@/theme";

function SmallButton({
  children,
  destructive = false,
  disabled = false,
  onPress,
}: {
  children: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.smallButton, destructive && styles.denyButton, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={[styles.smallButtonLabel, destructive && styles.denyLabel]}>{children}</Text>
    </Pressable>
  );
}

function AttentionPanel({ session, item, writable }: { session: SessionRef; item: PendingAttentionItem; writable: boolean }) {
  const runtime = useCompanionRuntime();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (value?: string) => {
    setBusy(true);
    setError(null);
    try { await runtime.respond(session, item, value); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "T4 did not accept that response."); }
    finally { setBusy(false); }
  };
  return (
    <View style={styles.attentionPanel}>
      <View style={styles.attentionHeadingRow}>
        <Text style={styles.attentionGlyph}>{item.kind === "question" ? "?" : "✓"}</Text>
        <View style={styles.flex}>
          <Text style={styles.attentionTitle}>{item.kind === "question" ? "Agent question" : item.kind === "plan" ? "Plan ready" : item.title}</Text>
          <Text style={styles.attentionSummary}>{item.kind === "question" ? item.question : item.summary}</Text>
        </View>
      </View>
      {item.kind === "question" ? (
        <>
          {item.options.length > 0 && (
            <View style={styles.optionList}>
              {item.options.map((option) => <SmallButton disabled={!writable || busy} key={option.id} onPress={() => void respond(option.id)}>{option.label}</SmallButton>)}
            </View>
          )}
          {item.allowText && (
            <View style={styles.questionInputRow}>
              <TextInput
                editable={writable && !busy}
                onChangeText={setDraft}
                placeholder="Type a response"
                placeholderTextColor={colors.textDim}
                style={styles.questionInput}
                value={draft}
              />
              <SmallButton disabled={!writable || busy || draft.trim() === ""} onPress={() => void respond(draft)}>Send</SmallButton>
            </View>
          )}
        </>
      ) : (
        <View style={styles.actionRow}>
          <SmallButton destructive disabled={!writable || busy} onPress={() => void respond("deny")}>Deny</SmallButton>
          <SmallButton disabled={!writable || busy} onPress={() => void respond("approve")}>Approve</SmallButton>
        </View>
      )}
      {!writable && <Text style={styles.readOnlyNote}>Open this session in T4 on your computer to take control before responding.</Text>}
      {error !== null && <Text style={styles.actionError}>{error}</Text>}
    </View>
  );
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const runtime = useCompanionRuntime();
  const scrollRef = useRef<ScrollView>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const openSession = runtime.openSession;
  const session = useMemo(
    () => sessionsFrom(runtime.projection).find((item) => String(item.sessionId) === id),
    [id, runtime.projection],
  );
  const warm = session === undefined ? undefined : warmSession(runtime.projection, String(session.hostId), String(session.sessionId));
  const entries = useMemo(
    () => (warm?.entries ?? []).map((entry) => ({ entry, text: entryText(entry.data) })).filter((item) => item.text !== null).slice(-60),
    [warm?.entries],
  );
  const confirmations = [...(warm?.confirmations.values() ?? [])] as readonly Record<string, unknown>[];

  useEffect(() => {
    if (session !== undefined) void openSession(session).catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : "T4 could not open this session."));
  }, [openSession, session]);

  if (session === undefined) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <Text style={styles.notFound}>That session is not available.</Text>
        <SmallButton onPress={() => router.back()}>Go back</SmallButton>
      </SafeAreaView>
    );
  }

  const writable = canWriteSession(session, warm !== undefined) && runtime.connection === "ready";
  const send = async () => {
    if (draft.trim() === "" || sending) return;
    const next = draft;
    setSending(true);
    setMessage(null);
    try {
      await runtime.sendMessage(session, next);
      setDraft("");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "T4 did not accept that message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.backButton}><Text style={styles.backLabel}>‹</Text></Pressable>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.headerTitle}>{projectName(session)}</Text>
            <Text style={styles.headerStatus}>{session.status === "active" ? "● Running" : "Idle"} · {runtime.connection === "ready" ? "Live" : "Reconnecting"}</Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          ref={scrollRef}
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
        >
          {entries.length === 0 ? (
            <View style={styles.loadingTranscript}><ActivityIndicator color={colors.blue} /><Text style={styles.loadingText}>Loading recent context…</Text></View>
          ) : entries.map(({ entry, text }) => {
            const role = entryRole(entry.data);
            return (
              <View key={String(entry.id)} style={styles.messageRow}>
                <View style={[styles.avatar, role === "Agent" && styles.agentAvatar]}><Text style={styles.avatarText}>{role[0]}</Text></View>
                <View style={styles.messageCopy}>
                  <Text style={styles.role}>{role}</Text>
                  <Text selectable style={styles.messageText}>{text}</Text>
                </View>
              </View>
            );
          })}

			{(session.attention?.pending ?? []).map((item) => <AttentionPanel item={item} key={`${item.kind}:${item.id}`} session={session} writable={writable} />)}
          {confirmations.map((confirmation) => {
            const confirmationId = typeof confirmation.confirmationId === "string" ? confirmation.confirmationId : null;
            const commandId = typeof confirmation.commandId === "string" ? confirmation.commandId : null;
            if (confirmationId === null || commandId === null) return null;
            return (
              <View key={confirmationId} style={styles.attentionPanel}>
                <Text style={styles.attentionTitle}>Confirmation required</Text>
                <Text style={styles.attentionSummary}>{typeof confirmation.summary === "string" ? confirmation.summary : "Review this action on your computer."}</Text>
                <View style={styles.actionRow}>
                  <SmallButton destructive disabled={runtime.connection !== "ready"} onPress={() => void runtime.decideConfirmation({ session, confirmationId, commandId, decision: "deny" })}>Deny</SmallButton>
                  <SmallButton disabled={runtime.connection !== "ready"} onPress={() => void runtime.decideConfirmation({ session, confirmationId, commandId, decision: "approve" })}>Approve</SmallButton>
                </View>
              </View>
            );
          })}
        </ScrollView>

        {message !== null && <Text style={styles.composerError}>{message}</Text>}
        {!writable && <Text style={styles.observerBanner}>Active in another app · read-only here</Text>}
        <View style={styles.composer}>
          <TextInput
            editable={writable && !sending}
            multiline
            onChangeText={setDraft}
            placeholder={writable ? "Reply or steer…" : "Read-only while another app owns this session"}
            placeholderTextColor={colors.textDim}
            style={styles.composerInput}
            value={draft}
          />
          <Pressable disabled={!writable || sending || draft.trim() === ""} onPress={() => void send()} style={[styles.sendButton, (!writable || sending || draft.trim() === "") && styles.disabled]}>
            {sending ? <ActivityIndicator color="white" /> : <Text style={styles.sendLabel}>↑</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.lg },
  notFound: { color: colors.textMuted, fontSize: 15 },
  header: { height: 58, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm },
  backButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backLabel: { color: colors.blue, fontSize: 36, lineHeight: 38 },
  headerCopy: { flex: 1, alignItems: "center", gap: 2 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  headerStatus: { color: colors.green, fontSize: 11 },
  headerSpacer: { width: 44 },
  transcript: { flex: 1 },
  transcriptContent: { paddingBottom: spacing.lg },
  loadingTranscript: { padding: spacing.xxl, alignItems: "center", gap: spacing.sm },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  messageRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  agentAvatar: { backgroundColor: colors.green },
  avatarText: { color: "white", fontSize: 13, fontWeight: "800" },
  messageCopy: { flex: 1, gap: spacing.xs },
  role: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  messageText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  attentionPanel: { margin: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: "#65521e", borderRadius: radius.md, backgroundColor: "#17160f", gap: spacing.sm },
  attentionHeadingRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  attentionGlyph: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: colors.amber, color: colors.amber, textAlign: "center", lineHeight: 24, fontWeight: "800" },
  attentionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  attentionSummary: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginTop: 3 },
  actionRow: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  optionList: { gap: spacing.xs },
  smallButton: { minHeight: 38, minWidth: 86, paddingHorizontal: spacing.md, borderRadius: radius.sm, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  smallButtonLabel: { color: "white", fontSize: 14, fontWeight: "700" },
  denyButton: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#6b3437" },
  denyLabel: { color: colors.red },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
  questionInputRow: { flexDirection: "row", gap: spacing.xs, alignItems: "center" },
  questionInput: { flex: 1, minHeight: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: spacing.sm },
  readOnlyNote: { color: colors.amber, fontSize: 12, lineHeight: 17 },
  actionError: { color: colors.red, fontSize: 12 },
  composerError: { color: colors.red, fontSize: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  observerBanner: { color: colors.amber, fontSize: 12, textAlign: "center", backgroundColor: "#211c10", paddingVertical: spacing.xs },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, padding: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.background },
  composerInput: { flex: 1, maxHeight: 120, minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 15, lineHeight: 20, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  sendButton: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  sendLabel: { color: "white", fontSize: 25, fontWeight: "800" },
});
