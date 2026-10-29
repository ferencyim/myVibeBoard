import type { PluginTheme } from "@getpaseo/plugin";
import type { PropsWithChildren } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

interface ThemeProps { theme: PluginTheme }
interface ButtonProps extends ThemeProps { label: string; onPress(): void; disabled?: boolean }
export function Button({ theme, label, onPress, disabled }: ButtonProps) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: theme.colors.foreground }}>{label}</Text></Pressable>;
}
interface FieldProps extends ThemeProps { label: string; value: string; onChangeText(value: string): void; multiline?: boolean }
export function Field({ theme, label, value, onChangeText, multiline }: FieldProps) {
  return <View style={{ gap: 6 }}><Text style={{ color: theme.colors.foreground }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} multiline={multiline} style={{ color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, minHeight: multiline ? 240 : 40, textAlignVertical: "top" }} /></View>;
}
export function Page({ theme, children }: PropsWithChildren<ThemeProps>) {
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 12 }}>{children}</ScrollView>;
}
export function Feedback({ theme, error, message }: ThemeProps & { error?: unknown; message?: string }) {
  return <><Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{message}</Text>{error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{String(error)}</Text> : null}</>;
}
