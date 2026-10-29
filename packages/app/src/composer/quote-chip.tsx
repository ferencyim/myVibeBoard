import { Text, View } from "react-native";
import { X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { IconButton } from "@/ui/icon-button";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerQuote } from "./quote";

export function ComposerQuoteChip({
  quote,
  onClear,
}: {
  quote: ComposerQuote;
  onClear: (quote: ComposerQuote) => void;
}) {
  const { t } = useTranslation();
  const clear = useCallback(() => onClear(quote), [onClear, quote]);
  return (
    <View style={styles.container} testID="composer-quote">
      <View style={styles.content}>
        <Text style={styles.author} numberOfLines={1}>
          {quote.author}
        </Text>
        <Text style={styles.text} numberOfLines={2}>
          {quote.text}
        </Text>
      </View>
      <IconButton
        icon={X}
        size="xs"
        variant="ghost"
        label={t("common.actions.cancel")}
        onPress={clear}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: theme.spacing[12],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.bgSurfaceRaised,
    borderLeftWidth: theme.borderWidth[2],
    borderLeftColor: theme.colors.accent,
  },
  content: { flex: 1, gap: theme.spacing[0.5] },
  author: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.textMuted, fontSize: theme.fontSize.sm },
}));
