import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { Modal, useWindowDimensions, type View } from "react-native";
import { createPortal } from "react-dom";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { FloatingSurface } from "@/components/ui/floating";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  computePickerPlacement,
  type PickerPlacement,
  type PickerRect,
} from "@/components/provider-model-picker/placement";
import type { PickerKeyHandler } from "@/components/provider-model-picker/picker-panel";
import { isWeb } from "@/constants/platform";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";

/**
 * Anchored popover for the model picker. It measures the trigger first and mounts nothing until
 * that measurement lands (so there is no first-frame flash), then positions itself with
 * `computePickerPlacement`, which flips above the trigger and caps the height to the room left.
 * Web renders into the shared overlay root; native uses a Modal (Android hit-testing).
 */
export function PickerPopover(props: {
  open: boolean;
  anchorRef: RefObject<View | null>;
  onClose: () => void;
  matchAnchorWidth?: boolean;
  keyHandlerRef: MutableRefObject<PickerKeyHandler | null>;
  children: ReactNode;
}) {
  const { open, anchorRef, onClose, matchAnchorWidth, keyHandlerRef, children } = props;
  const layer = useOverlayLayer("floating");
  const { width, height } = useWindowDimensions();
  const [anchor, setAnchor] = useState<PickerRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    anchorRef.current?.measureInWindow((x, y, w, h) => setAnchor({ x, y, width: w, height: h }));
  }, [anchorRef, open, width, height]);

  const placement = useMemo(
    () =>
      anchor
        ? computePickerPlacement({ anchor, viewport: { width, height }, matchAnchorWidth })
        : null,
    [anchor, height, matchAnchorWidth, width],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return true;
      }
      return keyHandlerRef.current?.(event.key, () => event.preventDefault()) ?? false;
    },
    [keyHandlerRef, onClose],
  );
  const setScope = useWebOverlayRegistration({
    active: isWeb && open,
    layer,
    onKeyDown: handleKeyDown,
  });

  useEffect(() => {
    if (!open) return undefined;
    return () => {
      keyHandlerRef.current = null;
    };
  }, [keyHandlerRef, open]);

  if (!open || !placement) return null;

  const overlay = (
    <OverlayLayerProvider layer={layer}>
      <PressHighlight style={styles.backdrop} onPress={onClose} accessibilityLabel="关闭" />
      <FloatingSurface
        ref={setScope}
        entering={FadeIn.duration(120)}
        exiting={FadeOut.duration(100)}
        style={styles.surface}
        frameStyle={frameStyle(placement)}
        collapsable={false}
        role="dialog"
        tabIndex={-1}
        testID="provider-model-picker-popover"
      >
        {children}
      </FloatingSurface>
    </OverlayLayerProvider>
  );

  if (isWeb && typeof document !== "undefined") {
    return createPortal(<div style={webOverlayStyle(layer)}>{overlay}</div>, getOverlayRoot());
  }
  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.nativeRoot}>{overlay}</GestureHandlerRootView>
    </Modal>
  );
}

function webOverlayStyle(layer: number) {
  return { position: "absolute", inset: 0, pointerEvents: "auto", zIndex: layer } as const;
}

function frameStyle(placement: PickerPlacement) {
  return {
    position: "absolute" as const,
    left: placement.left,
    top: placement.top,
    bottom: placement.bottom,
    width: placement.width,
    maxHeight: placement.maxHeight,
    minHeight: placement.minHeight,
  };
}

const styles = StyleSheet.create((theme) => ({
  nativeRoot: { flex: 1 },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  surface: {
    flexDirection: "row",
    overflow: "hidden",
    borderRadius: theme.borderRadius.card,
    backgroundColor: theme.colors.bgSheet,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    ...theme.shadow.md,
  },
}));
