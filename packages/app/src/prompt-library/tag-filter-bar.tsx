import { type ReactElement } from "react";
import { ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PromptTagChip } from "./tag-chip";

export interface PromptTagFilterOption {
  id: string;
  label: string;
  count: number;
}

/** A horizontally scrolling chip row: "All" clears, any other chip toggles through `onSelect`. */
export function PromptTagFilterBar({
  options,
  selectedIds,
  onSelect,
  onClear,
  testID,
}: {
  options: readonly PromptTagFilterOption[];
  selectedIds: readonly string[];
  onSelect: (id: string) => void;
  onClear: () => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
      testID={testID}
    >
      <PromptTagChip
        tag={t("promptLibrary.allTags")}
        selected={selectedIds.length === 0}
        onSelect={onClear}
        testID={`${testID}-all`}
      />
      {options.map((option) => (
        <PromptTagChip
          key={option.id}
          tag={option.label}
          value={option.id}
          count={option.count}
          selected={selectedIds.includes(option.id)}
          onSelect={onSelect}
          testID={`${testID}-${option.id}`}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flexGrow: 0,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
}));
