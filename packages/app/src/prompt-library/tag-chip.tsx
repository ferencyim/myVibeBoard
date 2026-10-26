import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";

export function PromptTagChip({
  tag,
  value,
  count,
  selected = false,
  onSelect,
  testID,
}: {
  tag: string;
  /** What `onSelect` receives; defaults to the label. */
  value?: string;
  count?: number;
  selected?: boolean;
  onSelect?: (value: string) => void;
  testID?: string;
}): ReactElement {
  const select = useCallback(() => onSelect?.(value ?? tag), [onSelect, tag, value]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const content = (
    <View style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
        {count === undefined ? tag : `${tag} · ${count}`}
      </Text>
    </View>
  );
  if (!onSelect) return content;
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={select}
      style={styles.pressable}
      testID={testID}
    >
      {content}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  pressable: {
    borderRadius: theme.borderRadius.full,
  },
  chip: {
    maxWidth: 200,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  chipSelected: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  labelSelected: {
    color: theme.colors.foreground,
  },
}));
