import type { ReactNode } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type BadgeVariant = "success" | "warning" | "error" | "muted";

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  leading?: ReactNode;
  /** `xs` fits beside a line of `sm` text: the same label on tighter padding. */
  size?: "sm" | "xs";
}

export function Badge({ label, variant = "muted", leading, size = "sm" }: BadgeProps) {
  return (
    <View
      style={[
        styles.pill,
        size === "xs" && styles.pillXs,
        variant === "success" && styles.pillSuccess,
        variant === "warning" && styles.pillWarning,
        variant === "error" && styles.pillError,
      ]}
    >
      {leading}
      <Text
        style={[
          styles.pillText,
          variant === "success" && styles.pillTextSuccess,
          variant === "warning" && styles.pillTextWarning,
          variant === "error" && styles.pillTextError,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgControl,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  pillXs: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
  },
  pillSuccess: {
    backgroundColor: theme.colors.successSoft,
    borderColor: "transparent",
  },
  pillWarning: {
    backgroundColor: theme.colors.warningSoft,
    borderColor: "transparent",
  },
  pillError: {
    backgroundColor: theme.colors.dangerSoft,
    borderColor: "transparent",
  },
  pillText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.lineHeight.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.textMuted,
  },
  pillTextSuccess: {
    color: theme.colors.successText,
  },
  pillTextWarning: {
    color: theme.colors.warningText,
  },
  pillTextError: {
    color: theme.colors.dangerText,
  },
}));
