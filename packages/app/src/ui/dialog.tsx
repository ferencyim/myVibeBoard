import { useMemo, useCallback, type ReactNode } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/ui/button";

export interface DialogProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
  maxWidth?: number;
}

export function Dialog({ title, maxWidth = 520, ...props }: DialogProps) {
  const header = useMemo(() => ({ title }), [title]);
  return <AdaptiveModalSheet {...props} header={header} desktopMaxWidth={maxWidth} />;
}

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  testID?: string;
}

/** The owner keeps failures visible and closes only after its action succeeds. */
export function ConfirmDialog({
  visible,
  title,
  message,
  onClose,
  onConfirm,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive = false,
  pending = false,
  testID,
}: ConfirmDialogProps) {
  const { height } = useWindowDimensions();
  const maxHeight = height - 48;
  const header = useMemo(() => ({ title }), [title]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" onPress={onClose} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          onPress={onConfirm}
          loading={pending}
          disabled={pending}
        >
          {confirmLabel}
        </Button>
      </View>
    ),
    [onClose, pending, cancelLabel, destructive, onConfirm, confirmLabel],
  );
  const requestClose = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);
  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={requestClose}
      footer={footer}
      desktopMaxWidth={460}
      desktopBorderRadius={20}
      desktopMaxHeight={maxHeight}
      surfaceVariant="confirmation"
      testID={testID}
    >
      <Text style={styles.message}>{message}</Text>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, flex: 1 },
  message: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
}));
