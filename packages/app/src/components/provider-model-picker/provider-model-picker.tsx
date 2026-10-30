import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Clock } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ModelProviderGlyph } from "@/components/model-provider-glyph";
import { PickerPopover } from "@/components/provider-model-picker/picker-popover";
import {
  ProviderModelPanel,
  type PickerKeyHandler,
  type PickerFast,
  type PickerPermission,
  type PickerThinking,
} from "@/components/provider-model-picker/picker-panel";
import { useOptimisticSelection } from "@/components/provider-model-picker/use-optimistic-selection";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import {
  resolveSelectedModelLabel,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export type {
  PickerFast,
  PickerPermission,
  PickerThinking,
} from "@/components/provider-model-picker/picker-panel";

const SHEET_SNAP_POINTS = ["80%", "90%"];
const SHEET_HEADER = { title: "选择模型" };
const ThemedChevron = withUnistyles(ChevronDown);
const ThemedClock = withUnistyles(Clock);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface ProviderModelPickerTriggerState {
  selectedModelLabel: string;
  onPress: () => void;
  disabled: boolean;
  isOpen: boolean;
  hovered: boolean;
  pressed: boolean;
}

export interface ProviderModelPickerProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  /** May return a promise; a rejection rolls the optimistic selection back. */
  onSelect: (provider: string, modelId: string) => void | Promise<unknown>;
  isLoading: boolean;
  thinking?: PickerThinking | null;
  fast?: PickerFast | null;
  permission?: PickerPermission | null;
  onRetryProvider?: (provider: string) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  onOpen?: () => void;
  onClose?: () => void;
  renderTrigger?: (state: ProviderModelPickerTriggerState) => ReactNode;
  /** Full-width form-field trigger: the popover is as wide as the trigger. */
  triggerFill?: boolean;
  glyphSize?: number;
}

function shortModelLabel(label: string): string {
  const separator = label.lastIndexOf("/");
  return separator === -1 ? label : label.slice(separator + 1);
}

export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const {
    providers,
    isLoading,
    thinking = null,
    fast = null,
    permission = null,
    onRetryProvider,
    isRetryingProvider,
    disabled = false,
    serverId = null,
    onOpen,
    onClose,
    renderTrigger,
    triggerFill = false,
    glyphSize = ICON_SIZE.md,
  } = props;
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const anchorRef = useRef<View>(null);
  const keyHandlerRef = useRef<PickerKeyHandler | null>(null);
  const [open, setOpen] = useState(false);
  const handleFailure = useCallback((message: string) => toast.error(message), [toast]);
  const selection = useOptimisticSelection({
    selectedProvider: props.selectedProvider,
    selectedModel: props.selectedModel,
    thinking,
    onSelect: props.onSelect,
    onFailure: handleFailure,
  });

  const modelLabel = shortModelLabel(
    resolveSelectedModelLabel({
      providers,
      selectedProvider: selection.provider,
      selectedModel: selection.model,
      isLoading,
    }),
  );
  const effortLabel = selection.thinking?.options.find(
    (option) => option.id === selection.thinking?.selectedId,
  )?.label;

  const handleOpen = useCallback(() => {
    setOpen(true);
    onOpen?.();
  }, [onOpen]);
  const handleClose = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);
  const handleToggle = useCallback(() => {
    if (open) handleClose();
    else handleOpen();
  }, [handleClose, handleOpen, open]);

  const hasEffortRow =
    Boolean(selection.thinking && selection.thinking.options.length > 0) ||
    Boolean(fast) ||
    Boolean(permission && permission.options.length > 0);
  const { pick } = selection;
  const handlePick = useCallback(
    (provider: string, modelId: string) => {
      // The label updates first; the request goes out in the background.
      pick(provider, modelId);
      if (!hasEffortRow) handleClose();
    },
    [handleClose, hasEffortRow, pick],
  );

  const panel = (
    <ProviderModelPanel
      providers={providers}
      selectedProvider={selection.provider}
      selectedModel={selection.model}
      isLoading={isLoading}
      thinking={selection.thinking}
      fast={fast}
      permission={permission}
      onPick={handlePick}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
      serverId={serverId}
      autoFocusSearch={isWeb && !compact}
      keyHandlerRef={keyHandlerRef}
    />
  );

  const accessibilityLabel = `模型：${[modelLabel, effortLabel].filter(Boolean).join(" · ")}`;
  const customStyle = useMemo(
    () => [triggerFill ? styles.fill : styles.customWrapper, disabled && styles.disabled],
    [disabled, triggerFill],
  );

  const trigger = renderTrigger ? (
    <PressHighlight
      ref={anchorRef}
      collapsable={false}
      disabled={disabled}
      onPress={handleToggle}
      style={customStyle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID="combined-model-selector"
    >
      {({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) =>
        renderTrigger({
          selectedModelLabel: modelLabel,
          onPress: handleToggle,
          disabled,
          isOpen: open,
          hovered: Boolean(hovered),
          pressed,
        })
      }
    </PressHighlight>
  ) : (
    <PillTrigger
      anchorRef={anchorRef}
      open={open}
      disabled={disabled}
      onPress={handleToggle}
      accessibilityLabel={accessibilityLabel}
      provider={selection.provider}
      serverId={serverId}
      glyphSize={glyphSize}
      modelLabel={modelLabel}
      effortLabel={effortLabel}
      fastOn={Boolean(fast?.value)}
    />
  );

  return (
    <>
      {trigger}
      {compact ? (
        <AdaptiveModalSheet
          header={SHEET_HEADER}
          visible={open}
          onClose={handleClose}
          snapPoints={SHEET_SNAP_POINTS}
          scrollable={false}
          contentStyle={styles.sheetBody}
          testID="provider-model-picker-sheet"
        >
          <View style={styles.sheetViewport}>{open ? panel : null}</View>
        </AdaptiveModalSheet>
      ) : (
        <PickerPopover
          open={open}
          anchorRef={anchorRef}
          onClose={handleClose}
          matchAnchorWidth={triggerFill}
          keyHandlerRef={keyHandlerRef}
        >
          {panel}
        </PickerPopover>
      )}
    </>
  );
}

function PillTrigger(props: {
  anchorRef: React.RefObject<View | null>;
  open: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  provider: string;
  serverId: string | null;
  glyphSize: number;
  modelLabel: string;
  effortLabel: string | undefined;
  fastOn: boolean;
}) {
  const { open, disabled } = props;
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.pill,
      (Boolean(hovered) || open) && styles.pillHot,
      pressed && styles.pillPressed,
      disabled && styles.disabled,
    ],
    [disabled, open],
  );
  return (
    <PressHighlight
      ref={props.anchorRef}
      collapsable={false}
      disabled={disabled}
      onPress={props.onPress}
      style={style}
      accessibilityRole="button"
      aria-expanded={open}
      accessibilityLabel={props.accessibilityLabel}
      testID="combined-model-selector"
    >
      {props.provider.trim().length > 0 ? (
        <ModelProviderGlyph
          provider={props.provider}
          serverId={props.serverId}
          size={Math.min(props.glyphSize, 15)}
        />
      ) : null}
      <Text style={styles.pillModel} numberOfLines={1} ellipsizeMode="tail">
        {props.modelLabel}
      </Text>
      {props.fastOn ? <Text style={styles.pillExtra}>⚡ 快速</Text> : null}
      {props.effortLabel ? (
        <Text style={styles.pillExtra} numberOfLines={1}>
          {`· ${props.effortLabel}`}
        </Text>
      ) : null}
      <View style={open ? styles.chevronOpen : null}>
        <ThemedChevron size={13} uniProps={mutedMapping} />
      </View>
    </PressHighlight>
  );
}

/** "After this turn" badge shown next to the picker while a running turn keeps the old value. */
export function NextTurnBadge({ running, next }: { running: string; next: string }) {
  return (
    <View
      style={styles.badge}
      accessibilityRole="text"
      accessibilityLabel={`${running} 将跑完本轮，${next} 从下一轮开始生效`}
      testID="provider-model-picker-next-turn"
    >
      <ThemedClock size={12} uniProps={mutedMapping} />
      <Text style={styles.badgeText}>下轮生效</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    height: 28,
    minWidth: 0,
    maxWidth: 240,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    paddingRight: 9,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgOverlay,
  },
  pillHot: { borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.bgSurface },
  pillPressed: { transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.48 },
  pillModel: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.md,
    fontWeight: "500",
  },
  pillExtra: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.md,
  },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  customWrapper: { flexShrink: 1, minWidth: 0 },
  fill: { alignSelf: "stretch", flexShrink: 0, flexDirection: "column", alignItems: "stretch" },
  sheetBody: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 },
  sheetViewport: { flex: 1, minHeight: 0, backgroundColor: theme.colors.bgSheet },
  badge: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.hoverTint,
  },
  badgeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
