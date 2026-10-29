import { useCallback, type ComponentProps, type ComponentType } from "react";
import { Text } from "react-native";
import { buttonIconSize } from "@/components/ui/control-geometry";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "./button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";

export interface IconButtonProps extends Omit<
  ComponentProps<typeof Button>,
  "children" | "accessibilityLabel" | "leftIcon" | "trailing"
> {
  label: string;
  icon: ComponentType<{ color: string; size: number }>;
  tooltip?: boolean | string;
}

export function IconButton({
  label,
  icon,
  tooltip,
  size = "default",
  style,
  ...props
}: IconButtonProps) {
  const normalizedSize = size === "default" ? "md" : size;
  const Icon = icon;
  const renderIcon = useCallback(
    (color: string) => <Icon color={color} size={buttonIconSize[normalizedSize]} />,
    [Icon, normalizedSize],
  );
  const button = (
    <Button
      {...props}
      size={size}
      accessibilityLabel={label}
      leftIcon={renderIcon}
      style={[styles.base, styles[size], style]}
    />
  );
  if (!tooltip) return button;
  const tooltipLabel = typeof tooltip === "string" ? tooltip : label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: { paddingHorizontal: 0 },
  xs: { width: 24 },
  sm: { width: 32 },
  default: { width: 36 },
  md: { width: 36 },
  lg: { width: 40 },
  tooltipText: { color: theme.colors.textPrimary, fontSize: 12, lineHeight: 16, fontWeight: "600" },
}));
