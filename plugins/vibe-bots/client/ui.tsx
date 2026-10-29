import type { PluginTheme } from "@getpaseo/plugin";
import type { PropsWithChildren } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

// Same numbers as settings-kit.tsx so routines and list screens line up with the profile panel.
interface ThemeProps { theme: PluginTheme }
interface ButtonProps extends ThemeProps { label: string; onPress(): void; disabled?: boolean }
export function Button({ theme, label, onPress, disabled }: ButtonProps) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ minHeight: 32, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text></Pressable>;
}
interface FieldProps extends ThemeProps { label: string; value: string; onChangeText(value: string): void; multiline?: boolean }
export function Field({ theme, label, value, onChangeText, multiline }: FieldProps) {
  return <View style={{ gap: 6 }}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18, paddingLeft: 8 }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} multiline={multiline} style={{ color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 11, fontSize: 14, lineHeight: 19, minHeight: multiline ? 240 : 38, textAlignVertical: multiline ? "top" : "center", backgroundColor: theme.colors.surface1 }} /></View>;
}
export function Page({ theme, children }: PropsWithChildren<ThemeProps>) {
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ paddingTop: 24, paddingHorizontal: 15, paddingBottom: 28, gap: 16 }}>{children}</ScrollView>;
}
export function Feedback({ theme, error, message }: ThemeProps & { error?: unknown; message?: string }) {
  return <>{message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, paddingLeft: 8 }}>{message}</Text> : null}{error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12, lineHeight: 16, paddingLeft: 8 }}>{String(error)}</Text> : null}</>;
}
