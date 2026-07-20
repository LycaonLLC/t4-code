import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";

import { reconcileVoiceTranscript, type VoiceTranscriptRange } from "@/runtime/voice-transcript";
import { colors, radius, spacing } from "@/theme";

type VoiceInputState = "idle" | "starting" | "listening" | "processing";

function voiceErrorMessage(error: string, message: string): string {
  if (error === "no-speech" || error === "speech-timeout") return "No speech was recognized.";
  if (error === "not-allowed") return "Microphone or speech recognition permission was denied.";
  if (error === "service-not-allowed" || error === "language-not-supported") {
    return "Speech recognition is unavailable on this device.";
  }
  return message.trim() === "" ? "Speech recognition failed." : message;
}

export function VoiceInputButton({
  disabled,
  onChangeText,
  onError,
  value,
}: {
  readonly disabled: boolean;
  readonly onChangeText: (text: string) => void;
  readonly onError: (message: string) => void;
  readonly value: string;
}) {
  const [state, setState] = useState<VoiceInputState>("idle");
  const latestValue = useRef(value);
  const startGeneration = useRef(0);
  const transcriptRange = useRef<VoiceTranscriptRange | undefined>(undefined);
  latestValue.current = value;

  useSpeechRecognitionEvent("start", () => setState("listening"));
  useSpeechRecognitionEvent("result", (event) => {
    const update = reconcileVoiceTranscript(
      latestValue.current,
      event.results[0]?.transcript ?? "",
      transcriptRange.current,
    );
    if (update !== undefined) {
      latestValue.current = update.value;
      transcriptRange.current = update.range;
      onChangeText(update.value);
    }
    if (event.isFinal) setState("processing");
  });
  useSpeechRecognitionEvent("error", (event) => {
    setState("idle");
    if (event.error !== "aborted") onError(voiceErrorMessage(event.error, event.message));
  });
  useSpeechRecognitionEvent("nomatch", () => {
    setState("idle");
    onError("No speech was recognized.");
  });
  useSpeechRecognitionEvent("end", () => setState("idle"));

  useEffect(
    () => () => {
      startGeneration.current += 1;
      ExpoSpeechRecognitionModule.abort();
    },
    [],
  );

  const toggle = async () => {
    if (state !== "idle") {
      startGeneration.current += 1;
      if (state === "starting") {
        setState("idle");
        ExpoSpeechRecognitionModule.abort();
      } else {
        setState("processing");
        ExpoSpeechRecognitionModule.stop();
      }
      return;
    }
    if (disabled) return;
    if (Platform.OS === "web" || !ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      onError("Speech recognition is unavailable on this device.");
      return;
    }
    setState("starting");
    onError("");
    const generation = startGeneration.current + 1;
    startGeneration.current = generation;
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (startGeneration.current !== generation) return;
      if (!permission.granted) {
        setState("idle");
        onError("Microphone or speech recognition permission was denied.");
        return;
      }
      transcriptRange.current = undefined;
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        maxAlternatives: 1,
        continuous: false,
        requiresOnDeviceRecognition: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
      });
    } catch (caught) {
      if (startGeneration.current !== generation) return;
      setState("idle");
      onError(caught instanceof Error ? caught.message : "Speech recognition failed.");
    }
  };

  const active = state !== "idle";
  const label = state === "listening" ? "Stop" : state === "idle" ? "Voice" : "Wait";
  return (
    <Pressable
      accessibilityLabel={active ? "Stop voice input" : "Start voice input"}
      accessibilityState={{ disabled: disabled && !active, selected: active }}
      disabled={disabled && !active}
      onPress={() => void toggle()}
      style={({ pressed }) => [
        styles.button,
        active && styles.active,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.label, active && styles.activeLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    minWidth: 58,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  active: { borderColor: colors.red, backgroundColor: "#251214" },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  activeLabel: { color: colors.red },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
});
