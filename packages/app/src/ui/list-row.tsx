import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useReducedMotion } from "react-native-reanimated";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  avatar?: ReactNode;
  trailing?: ReactNode;
  variant?: "default" | "settings";
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function ListRow({
  title,
  subtitle,
  avatar,
  trailing,
  variant = "default",
  selected = false,
  disabled = false,
  onPress,
  accessibilityLabel,
  style,
}: ListRowProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  const reducedMotion = useReducedMotion();
  const interactive = Boolean(onPress) && !disabled;
  const showHover = hovered && interactive;
  const scaleOnPress = pressed && !reducedMotion;
  const accessibilityState = useMemo(() => ({ disabled, selected }), [disabled, selected]);
  const pointerEntered = useCallback(() => setHovered(true), []);
  const pointerLeft = useCallback(() => setHovered(false), []);
  const focusedRow = useCallback(() => setFocused(true), []);
  const blurredRow = useCallback(() => setFocused(false), []);
  const pressStarted = useCallback(() => setPressed(true), []);
  const pressEnded = useCallback(() => setPressed(false), []);
  const pointerEvents = disabled ? "none" : "auto";
  return (
    <View
      onPointerEnter={pointerEntered}
      onPointerLeave={pointerLeft}
      pointerEvents={pointerEvents}
      style={style}
    >
      <View
        style={[
          styles.row,
          variant === "settings" && styles.settings,
          selected && styles.selected,
          showHover && styles.hovered,
          disabled && styles.disabled,
          focused && styles.focused,
          scaleOnPress && styles.pressed,
        ]}
      >
        {onPress && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? title}
            accessibilityState={accessibilityState}
            disabled={disabled}
            onPress={onPress}
            onFocus={focusedRow}
            onBlur={blurredRow}
            onPressIn={pressStarted}
            onPressOut={pressEnded}
            style={styles.pressTarget}
          />
        )}
        <View pointerEvents="box-none" style={styles.content}>
          {avatar && (
            <View pointerEvents="none" style={styles.leading}>
              {avatar}
            </View>
          )}
          <View pointerEvents="none" style={styles.copy}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {subtitle && (
              <Text numberOfLines={1} style={styles.subtitle}>
                {subtitle}
              </Text>
            )}
          </View>
          {trailing && <View style={styles.trailing}>{trailing}</View>}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 54,
    borderRadius: theme.borderRadius.md,
    justifyContent: "center",
    outlineWidth: 0,
  },
  settings: { minHeight: 64 },
  selected: { backgroundColor: theme.colors.bgControlActive },
  hovered: { backgroundColor: theme.colors.hoverTint },
  disabled: { opacity: 0.45 },
  focused: {
    outlineWidth: 1,
    outlineStyle: "solid",
    outlineColor: theme.colors.textMuted,
    outlineOffset: -1,
  },
  pressed: { transform: [{ scale: 0.99 }], backgroundColor: theme.colors.bgControlActive },
  pressTarget: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: theme.borderRadius.md,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  leading: { flexShrink: 0 },
  copy: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    lineHeight: theme.lineHeight.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.textPrimary,
  },
  subtitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.md,
    lineHeight: theme.lineHeight.md,
    color: theme.colors.textMuted,
  },
  trailing: { flexShrink: 0, alignItems: "center", justifyContent: "center" },
}));
