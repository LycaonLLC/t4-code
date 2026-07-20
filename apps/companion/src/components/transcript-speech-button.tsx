import * as Speech from "expo-speech";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";

import { colors, radius, spacing } from "@/theme";

export function TranscriptSpeechButton({
  onError,
  text,
}: {
  readonly onError: (message: string) => void;
  readonly text: string | null;
}) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => () => {
    void Speech.stop();
  }, []);

  const toggle = async () => {
    try {
      if (speaking) {
        await Speech.stop();
        setSpeaking(false);
        return;
      }
      if (text === null) return;
      setSpeaking(true);
      Speech.speak(text.slice(0, Speech.maxSpeechInputLength), {
        onDone: () => setSpeaking(false),
        onStopped: () => setSpeaking(false),
        onError: () => {
          setSpeaking(false);
          onError("Speech could not read this response.");
        },
      });
    } catch (caught) {
      setSpeaking(false);
      onError(caught instanceof Error ? caught.message : "Speech is unavailable.");
    }
  };

  return (
    <Pressable
      accessibilityLabel={speaking ? "Stop reading response" : "Read latest agent response"}
      disabled={text === null && !speaking}
      onPress={() => void toggle()}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, text === null && !speaking && styles.disabled]}
    >
      <Text style={styles.label}>{speaking ? "Stop" : "Listen"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 36,
    minWidth: 64,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { color: colors.text, fontSize: 12, fontWeight: "700" },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
});
