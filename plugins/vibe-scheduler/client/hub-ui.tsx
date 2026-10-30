import type { PluginTheme } from "@getpaseo/plugin";
import React, { type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

export function Section({
  theme,
  title,
  children,
  right,
}: {
  theme: PluginTheme;
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.borderRadius?.md ?? 12,
        padding: theme.spacing?.[4] ?? 16,
        gap: theme.spacing?.[3] ?? 12,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 15 }}>
          {title}
        </Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export const Muted = ({ theme, children }: { theme: PluginTheme; children: ReactNode }) => (
  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>
);

export function Row({ theme, left, right }: { theme: PluginTheme; left: string; right: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{left}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, flexShrink: 1, textAlign: "right" }}>
        {right}
      </Text>
    </View>
  );
}

export function Button({
  theme,
  label,
  onPress,
  active,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: active ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({
  theme,
  value,
  onChangeText,
  placeholder,
}: {
  theme: PluginTheme;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      style={{
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        fontSize: 14,
      }}
    />
  );
}
