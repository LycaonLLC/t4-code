import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";

import { colors } from "@/theme";

function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 18, fontWeight: "700" }}>{glyph}</Text>;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.textDim,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Inbox", tabBarIcon: ({ color }) => <TabIcon color={color} glyph="▰" /> }} />
      <Tabs.Screen name="sessions" options={{ title: "Sessions", tabBarIcon: ({ color }) => <TabIcon color={color} glyph="≡" /> }} />
      <Tabs.Screen name="hosts" options={{ title: "Host", tabBarIcon: ({ color }) => <TabIcon color={color} glyph="▣" /> }} />
    </Tabs>
  );
}
