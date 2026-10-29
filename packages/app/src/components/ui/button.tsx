import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  default as React,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View, StyleSheet as NativeStyleSheet } from "react-native";
import type {
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  buttonIconSize,
  createControlGeometry,
  type ButtonControlSize,
} from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
export type ButtonSize = ButtonControlSize | "default";

type LeftIcon =
  | ReactElement
  | ComponentType<{ color: string; size: number }>
  | ((color: string) => ReactElement)
  | null;

interface ButtonIconProps {
  loading: boolean;
  leftIcon?: LeftIcon;
  iconSize: number;
  iconColor: string;
}

function ButtonIcon({ loading, leftIcon, iconSize, iconColor }: ButtonIconProps) {
  if (loading) {
    return (
      <View>
        <LoadingSpinner size="small" color={iconColor} />
      </View>
    );
  }

  if (!leftIcon) return null;

  if (typeof leftIcon === "object" && "type" in leftIcon) {
    return <View>{leftIcon}</View>;
  }

  if (
    typeof leftIcon === "function" &&
    !leftIcon.prototype?.isReactComponent &&
    leftIcon.length > 0
  ) {
    return <View>{(leftIcon as (color: string) => ReactElement)(iconColor)}</View>;
  }

  const Icon = leftIcon as ComponentType<{ color: string; size: number }>;
  return (
    <View>
      <Icon color={iconColor} size={iconSize} />
    </View>
  );
}

const ThemedButtonIcon = withUnistyles(ButtonIcon);

const foregroundIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foreground });
const foregroundMutedIconMapping = (theme: Theme) => ({
  iconColor: theme.colors.foregroundMuted,
});
const accentForegroundIconMapping = (theme: Theme) => ({
  iconColor: theme.colors.primaryForeground,
});
const accentTextIconMapping = (theme: Theme) => ({ iconColor: theme.colors.accentText });
const destructiveForegroundIconMapping = (theme: Theme) => ({
  iconColor: theme.colors.dangerText,
});

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    base: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: "transparent",
    },
    md: {
      ...geometry.buttonMd,
    },
    xs: {
      ...geometry.buttonXs,
    },
    sm: {
      ...geometry.buttonSm,
    },
    lg: {
      ...geometry.buttonLg,
    },
    default: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    secondary: {
      backgroundColor: theme.colors.hoverTint,
      borderColor: theme.colors.hoverTint,
    },
    outline: {
      backgroundColor: theme.colors.bgControl,
      borderColor: theme.colors.borderStrong,
    },
    ghost: {
      backgroundColor: "transparent",
      borderColor: "transparent",
    },
    destructive: {
      backgroundColor: theme.colors.dangerSoft,
      borderColor: "transparent",
    },
    link: {
      backgroundColor: "transparent",
      borderColor: "transparent",
    },
    hovered: { backgroundColor: theme.colors.bgControlHover },
    primaryHovered: { opacity: 0.9 },
    destructiveHovered: { backgroundColor: theme.colors.dangerSoftHover },
    linkText: { color: theme.colors.accentText },
    linkHoveredText: { textDecorationLine: "underline" },
    focused: {
      outlineWidth: 1,
      outlineStyle: "solid",
      outlineColor: theme.colors.textMuted,
      outlineOffset: 1,
    },
    pressed: {
      transform: [{ scale: 0.97 }],
    },
    disabled: {
      opacity: 0.45,
    },
    text: {
      color: theme.colors.foreground,
      ...geometry.buttonText,
      lineHeight: theme.lineHeight.base,
      fontFamily: theme.fontFamily.ui,
      fontWeight: theme.fontWeight.medium,
    },
    textXs: {
      ...geometry.buttonTextXs,
      lineHeight: theme.lineHeight.sm,
    },
    textDefault: {
      color: theme.colors.primaryForeground,
    },
    textDestructive: {
      color: theme.colors.dangerText,
    },
    textGhost: {
      color: theme.colors.foregroundMuted,
    },
    textGhostHovered: {
      color: theme.colors.foreground,
    },
  };
});

export function Button({
  children,
  variant = "default",
  size = "default",
  leftIcon,
  trailing,
  style,
  textStyle,
  disabled,
  loading = false,
  accessibilityRole,
  accessibilityState: accessibilityStateProp,
  onFocus,
  onBlur,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    ref?: React.Ref<View>;
    variant?: ButtonVariant;
    size?: ButtonSize;
    leftIcon?: LeftIcon;
    trailing?: ReactNode;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
    loading?: boolean;
  }
>) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const reduceMotion = useReducedMotion();
  const controlSize = size === "default" ? "md" : size;
  const isDisabled = disabled || loading;
  // Keep the hover envelope in the same parent flex slot as the original button.
  const flattenedStyle = NativeStyleSheet.flatten(style);
  const envelopeStyle = useMemo(
    () => ({
      position: "relative" as const,
      flex: flattenedStyle?.flex,
      flexGrow: flattenedStyle?.flexGrow,
      flexShrink: flattenedStyle?.flexShrink,
      flexBasis: flattenedStyle?.flexBasis,
      alignSelf: flattenedStyle?.alignSelf,
    }),
    [
      flattenedStyle?.flex,
      flattenedStyle?.flexGrow,
      flattenedStyle?.flexShrink,
      flattenedStyle?.flexBasis,
      flattenedStyle?.alignSelf,
    ],
  );

  const variantStyle = styles[variant];
  const sizeStyle = styles[controlSize];
  const isGhostHovered = hovered && variant === "ghost";

  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const handleFocus = useCallback<NonNullable<PressableProps["onFocus"]>>(
    (event) => {
      setFocused(true);
      onFocus?.(event);
    },
    [onFocus],
  );
  const handleBlur = useCallback<NonNullable<PressableProps["onBlur"]>>(
    (event) => {
      setFocused(false);
      onBlur?.(event);
    },
    [onBlur],
  );

  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
      styles.base,
      sizeStyle,
      variantStyle,
      hovered && variant !== "link" && variant !== "default" ? styles.hovered : null,
      hovered && variant === "default" ? styles.primaryHovered : null,
      hovered && variant === "destructive" ? styles.destructiveHovered : null,
      focused ? styles.focused : null,
      pressed && !reduceMotion ? styles.pressed : null,
      isDisabled ? styles.disabled : null,
      style,
    ],
    [sizeStyle, variantStyle, hovered, variant, focused, reduceMotion, isDisabled, style],
  );

  const resolvedTextStyle = useMemo(
    () => [
      styles.text,
      size === "xs" ? styles.textXs : null,
      variant === "default" ? styles.textDefault : null,
      variant === "destructive" ? styles.textDestructive : null,
      variant === "ghost" ? styles.textGhost : null,
      variant === "link" ? styles.linkText : null,
      hovered && variant === "link" ? styles.linkHoveredText : null,
      textStyle,
      isGhostHovered ? styles.textGhostHovered : null,
    ],
    [size, variant, hovered, textStyle, isGhostHovered],
  );

  const accessibilityState = useMemo(
    () => ({ ...accessibilityStateProp, disabled: isDisabled, busy: loading }),
    [accessibilityStateProp, isDisabled, loading],
  );

  function resolveIconMapping() {
    if (variant === "default") {
      return accentForegroundIconMapping;
    }
    if (variant === "destructive") {
      return destructiveForegroundIconMapping;
    }
    if (variant === "link") {
      return accentTextIconMapping;
    }
    if (variant === "ghost") {
      return isGhostHovered ? foregroundIconMapping : foregroundMutedIconMapping;
    }
    return foregroundIconMapping;
  }

  return (
    <View style={envelopeStyle} onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
      <Pressable
        {...props}
        accessibilityRole={accessibilityRole ?? "button"}
        accessibilityState={accessibilityState}
        disabled={isDisabled}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={pressableStyle}
      >
        <ThemedButtonIcon
          loading={loading}
          leftIcon={leftIcon}
          iconSize={buttonIconSize[controlSize]}
          uniProps={resolveIconMapping()}
        />
        {children != null ? <Text style={resolvedTextStyle}>{children}</Text> : null}
        {trailing}
      </Pressable>
    </View>
  );
}
