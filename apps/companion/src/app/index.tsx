import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useCompanionRuntime } from "@/runtime/companion-runtime";
import { colors, radius, spacing } from "@/theme";

function Brand() {
  return (
    <View style={styles.brand}>
      <Text style={styles.mark}>T4</Text>
      <Text style={styles.brandLabel}>Companion</Text>
    </View>
  );
}

function TrustNote({ symbol, title, body }: { symbol: string; title: string; body: string }) {
  return (
    <View style={styles.trustRow}>
      <Text style={styles.trustSymbol}>{symbol}</Text>
      <View style={styles.trustCopy}>
        <Text style={styles.trustTitle}>{title}</Text>
        <Text style={styles.trustBody}>{body}</Text>
      </View>
    </View>
  );
}

function ConnectScreen({ initialAddress = "", initialMessage = null }: {
  initialAddress?: string;
  initialMessage?: string | null;
}) {
  const { configureHost, error } = useCompanionRuntime();
  const [address, setAddress] = useState(initialAddress);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await configureHost(address);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Check the address and try again.");
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.connectPage}>
        <Brand />
        <View style={styles.intro}>
          <Text style={styles.headline}>Mission control for your AI coding sessions—on your terms.</Text>
          <Text style={styles.subhead}>T4 connects to your computer over Tailscale. Your projects and agents stay on your machine.</Text>
        </View>
        <View style={styles.form}>
          <Text style={styles.label}>Tailnet HTTPS address</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setAddress}
            onSubmitEditing={() => void submit()}
            placeholder="your-mac.tailnet.ts.net:8445"
            placeholderTextColor={colors.textDim}
            returnKeyType="go"
            style={styles.input}
            value={address}
          />
          {(message ?? error) !== null && <Text style={styles.error}>{message ?? error}</Text>}
          <Pressable
            accessibilityRole="button"
            disabled={submitting}
            onPress={() => void submit()}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryPressed, submitting && styles.disabled]}
          >
            {submitting ? <ActivityIndicator color="white" /> : <Text style={styles.primaryLabel}>Connect securely</Text>}
          </Pressable>
        </View>
        <View style={styles.trustList}>
          <TrustNote symbol="•••" title="Secured by Tailscale" body="The app only accepts a private .ts.net address." />
          <TrustNote symbol="▣" title="Local-first by design" body="T4 supervises work running on your computer." />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function PairScreen() {
  const { pair, error, forgetHost } = useCompanionRuntime();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      await pair(code);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Pairing failed.");
      setSubmitting(false);
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.pairPage}>
        <Brand />
        <Text style={styles.pairTitle}>Pair this phone</Text>
        <Text style={styles.subhead}>Enter the six-digit code shown by T4 Code on your computer.</Text>
        <TextInput
          autoFocus
          keyboardType="number-pad"
          maxLength={6}
          onChangeText={setCode}
          onSubmitEditing={() => void submit()}
          placeholder="000000"
          placeholderTextColor={colors.textDim}
          style={styles.codeInput}
          value={code}
        />
        {(message ?? error) !== null && <Text style={styles.error}>{message ?? error}</Text>}
        <Pressable disabled={code.length !== 6 || submitting} onPress={() => void submit()} style={[styles.primaryButton, (code.length !== 6 || submitting) && styles.disabled]}>
          {submitting ? <ActivityIndicator color="white" /> : <Text style={styles.primaryLabel}>Pair securely</Text>}
        </Pressable>
        <Pressable onPress={() => void forgetHost()} style={styles.textButton}><Text style={styles.textButtonLabel}>Use a different host</Text></Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function LinkedHostScreen({ address, profile }: { address: string; profile?: string }) {
  const { configureHost } = useCompanionRuntime();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void configureHost(address, profile).then(
      () => {
        if (active) router.replace("/(tabs)");
      },
      (caught: unknown) => {
        if (active) setMessage(caught instanceof Error ? caught.message : "Check the address and try again.");
      },
    );
    return () => {
      active = false;
    };
  }, [address, configureHost, profile, router]);

  if (message !== null) return <ConnectScreen initialAddress={address} initialMessage={message} />;
  return <SafeAreaView style={[styles.safe, styles.loading]}><Brand /><ActivityIndicator color={colors.blue} /></SafeAreaView>;
}

export default function IndexScreen() {
  const { host, connection } = useCompanionRuntime();
  const params = useLocalSearchParams<{ address?: string; profile?: string }>();
  const linkedAddress = Array.isArray(params.address) ? params.address[0] : params.address;
  const linkedProfile = Array.isArray(params.profile) ? params.profile[0] : params.profile;
  if (connection === "loading") {
    return <SafeAreaView style={[styles.safe, styles.loading]}><Brand /><ActivityIndicator color={colors.blue} /></SafeAreaView>;
  }
  if (linkedAddress !== undefined) return <LinkedHostScreen address={linkedAddress} profile={linkedProfile} />;
  if (host === null) return <ConnectScreen initialAddress={linkedAddress} />;
  if (connection === "pairing") return <PairScreen />;
  return <Redirect href="/(tabs)" />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  loading: { alignItems: "center", justifyContent: "center", gap: spacing.xl },
  connectPage: { flex: 1, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, justifyContent: "center" },
  pairPage: { flex: 1, padding: spacing.lg, justifyContent: "center" },
  brand: { alignItems: "center", marginBottom: spacing.xl },
  mark: { color: colors.text, fontSize: 58, fontWeight: "800", letterSpacing: -4 },
  brandLabel: { color: colors.textMuted, fontSize: 17, marginTop: -6 },
  intro: { alignItems: "center", gap: spacing.sm, marginBottom: spacing.xl },
  headline: { color: colors.text, fontSize: 18, lineHeight: 25, fontWeight: "700", textAlign: "center", maxWidth: 330 },
  subhead: { color: colors.textMuted, fontSize: 15, lineHeight: 22, textAlign: "center", maxWidth: 350 },
  form: { gap: spacing.sm },
  label: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  input: { height: 54, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.text, fontSize: 16, paddingHorizontal: spacing.md },
  codeInput: { height: 68, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.text, fontSize: 30, fontWeight: "700", letterSpacing: 12, textAlign: "center", marginVertical: spacing.xl },
  primaryButton: { minHeight: 54, borderRadius: radius.md, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md },
  primaryPressed: { backgroundColor: colors.bluePressed },
  primaryLabel: { color: "white", fontSize: 17, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  error: { color: colors.red, fontSize: 13, lineHeight: 18 },
  trustList: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.xl },
  trustRow: { flexDirection: "row", gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  trustSymbol: { color: colors.textMuted, width: 28, fontSize: 18, textAlign: "center" },
  trustCopy: { flex: 1, gap: 2 },
  trustTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  trustBody: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  pairTitle: { color: colors.text, fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: spacing.sm },
  textButton: { alignItems: "center", padding: spacing.md },
  textButtonLabel: { color: colors.blue, fontSize: 15, fontWeight: "600" },
});
