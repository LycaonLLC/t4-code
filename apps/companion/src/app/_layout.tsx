import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { AttentionNotificationsProvider } from "@/runtime/attention-notifications";
import { CompanionRuntimeProvider } from "@/runtime/companion-runtime";
import { colors } from "@/theme";

export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  return (
    <CompanionRuntimeProvider>
      <AttentionNotificationsProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: colors.background },
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
        </Stack>
      </AttentionNotificationsProvider>
    </CompanionRuntimeProvider>
  );
}
