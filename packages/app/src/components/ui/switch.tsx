import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  ReduceMotion,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { createControlGeometry, switchGeometry } from "@/components/ui/control-geometry";
import { MOTION, type Theme } from "@/styles/theme";

interface SwitchProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const TIMING = {
  duration: MOTION.normal,
  easing: Easing.bezier(0.77, 0, 0.175, 1),
  reduceMotion: ReduceMotion.System,
};

interface SwitchTrackProps {
  value: boolean;
  trackOffColor: string;
  trackOnColor: string;
  thumbOffColor: string;
  thumbOnColor: string;
}

function SwitchTrack({
  value,
  trackOffColor,
  trackOnColor,
  thumbOffColor,
  thumbOnColor,
}: SwitchTrackProps) {
  const progress = useDerivedValue(() => withTiming(value ? 1 : 0, TIMING));

  const trackAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [trackOffColor, trackOnColor]),
  }));

  const thumbAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [thumbOffColor, thumbOnColor]),
    transform: [{ translateX: progress.value * switchGeometry.thumbTravel }],
  }));

  const trackStyle = useMemo(() => [styles.switchTrack, trackAnimatedStyle], [trackAnimatedStyle]);
  const thumbStyle = useMemo(
    () => [styles.switchThumb, styles.thumb, thumbAnimatedStyle],
    [thumbAnimatedStyle],
  );

  return (
    <Animated.View style={trackStyle}>
      <Animated.View style={thumbStyle} />
    </Animated.View>
  );
}

const ThemedSwitchTrack = withUnistyles(SwitchTrack, (theme: Theme) => ({
  trackOffColor: theme.colors.bgControlActive,
  trackOnColor: theme.colors.accent,
  thumbOffColor: theme.colors.palette.white,
  thumbOnColor: theme.colors.accentForeground,
}));

export function Switch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  testID,
  style,
}: SwitchProps) {
  const [focused, setFocused] = useState(false);
  const reduceMotion = useReducedMotion();
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (disabled) return;
      onValueChange?.(!value);
    },
    [disabled, onValueChange, value],
  );

  const accessibilityState = useMemo(() => ({ checked: value, disabled }), [value, disabled]);
  const pressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.switchControl,
      focused ? styles.focused : null,
      pressed && !reduceMotion ? styles.pressed : null,
      disabled ? styles.disabled : null,
      style,
    ],
    [disabled, focused, reduceMotion, style],
  );

  return (
    <Pressable
      onPress={handlePress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      aria-checked={value}
      testID={testID}
      style={pressableStyle}
    >
      <ThemedSwitchTrack value={value} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    switchControl: {
      ...geometry.switchControl,
    },
    focused: {
      outlineWidth: 1,
      outlineColor: theme.colors.textMuted,
      outlineStyle: "solid",
      outlineOffset: 1,
    },
    pressed: { transform: [{ scale: 0.97 }] },
    switchTrack: {
      width: switchGeometry.trackWidth,
      height: switchGeometry.trackHeight,
      borderRadius: switchGeometry.trackHeight / 2,
      padding: (switchGeometry.trackHeight - switchGeometry.thumbSize) / 2,
      justifyContent: "center",
    },
    switchThumb: {
      width: switchGeometry.thumbSize,
      height: switchGeometry.thumbSize,
      borderRadius: switchGeometry.thumbSize / 2,
    },
    thumb: {
      shadowColor: "rgba(0, 0, 0, 0.25)",
      shadowOffset: { width: 0, height: 1 },
      shadowRadius: 2,
      shadowOpacity: 1,
      elevation: 2,
    },
    disabled: {
      opacity: 0.45,
    },
  };
});
