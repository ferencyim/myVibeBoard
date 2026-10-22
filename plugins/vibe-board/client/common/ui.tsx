// Small themed primitives shared by the board screens.

import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import React, { useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextInputProps } from "react-native";
import { useHost } from "./ctx";
import { withAlpha } from "./colors";
import { displayedFieldValue } from "./field";

type FocusEvt = Parameters<NonNullable<TextInputProps["onFocus"]>>[0];
type BlurEvt = Parameters<NonNullable<TextInputProps["onBlur"]>>[0];

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Btn({
  label,
  onPress,
  icon,
  variant = "default",
  disabled,
  small,
}: {
  label?: string;
  onPress: () => void;
  icon?: string;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  small?: boolean;
}) {
  const { theme } = useHost();
  const bg =
    variant === "primary"
      ? theme.colors.accent
      : variant === "danger"
        ? theme.colors.statusDanger
        : variant === "ghost"
          ? "transparent"
          : theme.colors.surface2;
  const fg =
    variant === "primary" || variant === "danger" ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: small ? 8 : 12,
        paddingVertical: small ? 4 : 8,
        borderRadius: 8,
        backgroundColor: bg,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? <Icon name={icon} size={small ? 14 : 16} color={fg} /> : null}
      {label ? <Text style={{ color: fg, fontSize: small ? 12 : 14 }}>{label}</Text> : null}
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  color,
  count,
  hint,
  variant = "dot",
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  color?: string;
  /** "flag": priority (outlined, flag icon); "tag": tinted fill. Both use their own color group. */
  variant?: "dot" | "flag" | "tag";
  count?: number;
  /** Secondary info shown as a hover tooltip (web) and read by screen readers, e.g. a project prefix. */
  hint?: string;
}) {
  const { theme } = useHost();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={hint ? `${label}（${hint}）` : undefined}
      {...(hint ? ({ title: hint } as object) : {})}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor:
          variant === "tag" && color
            ? selected
              ? color
              : withAlpha(color, 0.5)
            : variant === "flag" && color
              ? color
              : selected
                ? (color ?? theme.colors.accent)
                : theme.colors.border,
        backgroundColor:
          variant === "tag" && color
            ? withAlpha(color, selected ? 0.35 : 0.14)
            : variant === "flag" && color && selected
              ? withAlpha(color, 0.25)
              : selected
                ? theme.colors.surface2
                : theme.colors.surface1,
      }}
    >
      {variant === "flag" && color ? (
        <Icon name="Flag" size={11} color={color} />
      ) : variant === "dot" && color ? (
        <Dot color={color} size={8} />
      ) : null}
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
      {count !== undefined ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const { theme } = useHost();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      {children}
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{hint}</Text> : null}
    </View>
  );
}

export function TextField(props: TextInputProps & { multiline?: boolean }) {
  const { theme } = useHost();
  // Own the text while focused: the parent's value round-trips through async host re-renders,
  // and echoing a stale value back into the native input moves the caret (and can drop keystrokes).
  const [focused, setFocused] = useState(false);
  const [local, setLocal] = useState(props.value ?? "");
  const controlled = props.value !== undefined;
  return (
    <TextInput
      placeholderTextColor={theme.colors.foregroundMuted}
      {...props}
      {...(controlled
        ? {
            value: displayedFieldValue(focused, local, props.value!),
            onChangeText: (text: string) => {
              setLocal(text);
              props.onChangeText?.(text);
            },
            onFocus: (e: FocusEvt) => {
              setLocal(props.value!);
              setFocused(true);
              props.onFocus?.(e);
            },
            onBlur: (e: BlurEvt) => {
              setFocused(false);
              props.onBlur?.(e);
            },
          }
        : {})}
      style={[
        {
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 14,
          minHeight: props.multiline ? 80 : undefined,
          textAlignVertical: props.multiline ? "top" : "center",
        },
        props.style,
      ]}
    />
  );
}

export function Check({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { theme } = useHost();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: value ? theme.colors.accent : theme.colors.border,
          backgroundColor: value ? theme.colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Icon name="Check" size={14} color={theme.colors.accentForeground} /> : null}
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function Muted({ children, size = 12 }: { children: ReactNode; size?: number }) {
  const { theme } = useHost();
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: size }}>{children}</Text>;
}
