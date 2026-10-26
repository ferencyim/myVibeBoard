import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { promptLibrary } from "@/prompt-library";
import type { PromptLibraryNotice } from "@/prompt-library/internal/types";

export function promptLibraryErrorMessage(code: string, t: TFunction): string {
  switch (code) {
    case "prompt_title_required":
      return t("promptLibrary.errors.titleRequired");
    case "prompt_title_too_long":
      return t("promptLibrary.errors.titleTooLong");
    case "prompt_body_required":
      return t("promptLibrary.errors.bodyRequired");
    case "prompt_body_too_long":
      return t("promptLibrary.errors.bodyTooLong");
    case "prompt_tag_required":
      return t("promptLibrary.errors.tagRequired");
    case "prompt_library_cache_failed":
    case "prompt_library_sync_failed":
      return t("promptLibrary.errors.load");
    default:
      return t("promptLibrary.errors.save");
  }
}

export function PromptLibraryNoticeBanner({
  serverId,
  notice,
  testID,
}: {
  serverId: string;
  notice: PromptLibraryNotice | null;
  testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const dismiss = useCallback(() => promptLibrary.dismissNotice(serverId), [serverId]);
  if (!notice) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.text} testID={testID}>
        {t(`promptLibrary.notice.${notice}`)}
      </Text>
      <Button variant="ghost" size="sm" onPress={dismiss} testID={`${testID}-dismiss`}>
        {t("promptLibrary.notice.dismiss")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
