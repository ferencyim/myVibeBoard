import { useCallback, useState, type ReactElement } from "react";
import { BookOpen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { Theme } from "@/styles/theme";
import { PromptLibraryManagerSheet } from "./manager-sheet";
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
  const [managerOpen, setManagerOpen] = useState(false);

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const closeManager = useCallback(() => setManagerOpen(false), []);
  const openManager = useCallback(() => {
    setPickerOpen(false);
    setManagerOpen(true);
  }, []);
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
        onInsert={insert}
        onManage={openManager}
      />
      <PromptLibraryManagerSheet serverId={serverId} visible={managerOpen} onClose={closeManager} />
    </>
  );
}
