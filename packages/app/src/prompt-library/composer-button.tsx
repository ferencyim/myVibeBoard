import { useCallback, useRef, useState, type ReactElement } from "react";
import { router } from "expo-router";
import { BookOpen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { Theme } from "@/styles/theme";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { PromptLibraryPickerSheet } from "./picker-sheet";

const ThemedBookOpen = withUnistyles(BookOpen);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PromptLibraryComposerButton({
  serverId,
  onInsert,
}: {
  serverId: string;
  onInsert: (body: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  // Navigating while the sheet is still closing freezes its exit and leaves its backdrop behind.
  const manageAfterClose = useRef(false);
  const openManager = useCallback(() => {
    manageAfterClose.current = true;
    setPickerOpen(false);
  }, []);
  const onPickerDismiss = useCallback(() => {
    if (!manageAfterClose.current) return;
    manageAfterClose.current = false;
    router.push(buildSettingsHostSectionRoute(serverId, "prompts"));
  }, [serverId]);
  const insert = useCallback(
    (body: string) => {
      setPickerOpen(false);
      onInsert(body);
    },
    [onInsert],
  );

  return (
    <>
      <ToolbarButton
        label={t("promptLibrary.button")}
        onPress={openPicker}
        testID="composer-prompt-library-button"
      >
        <ThemedBookOpen size={16} uniProps={mutedMapping} />
      </ToolbarButton>
      <PromptLibraryPickerSheet
        serverId={serverId}
        visible={pickerOpen}
        onClose={closePicker}
        onDismiss={onPickerDismiss}
        onInsert={insert}
        onManage={openManager}
      />
    </>
  );
}
