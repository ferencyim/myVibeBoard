import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfilePicker } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { useProviderIcon } from "@/components/provider-icons";
import { ProviderModelPanel } from "@/components/provider-model-picker/picker-panel";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import {
  resolveSelectedModelLabel,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

const SNAP_POINTS = ["80%", "90%"];
const FIXED_MODEL_VIEWPORT_HEIGHT = 340;
const MODEL_PICKER_HEADER = { title: "选择模型" };

interface CompactModelSheetProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  thinkingLabel: string | null;
  onSelect: (provider: string, modelId: string) => void;
  isLoading: boolean;
  profiles?: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  glyphSize: number;
  canSwitchProvider: boolean;
  children: ReactNode;
}

function shortModelLabel(label: string): string {
  const separatorIndex = label.lastIndexOf("/");
  return separatorIndex === -1 ? label : label.slice(separatorIndex + 1);
}

export function CompactModelSheet({
  providers,
  selectedProvider,
  selectedModel,
  thinkingLabel,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  glyphSize,
  canSwitchProvider,
  children,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const [isOpen, setIsOpen] = useState(false);
  const [isModelBrowserOpen, setIsModelBrowserOpen] = useState(false);
  const availableProviders = useMemo(() => {
    if (canSwitchProvider) return providers;
    const fixedProvider =
      providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
    return fixedProvider ? [fixedProvider] : [];
  }, [canSwitchProvider, providers, selectedProvider]);
  const selectedModelLabel = shortModelLabel(
    resolveSelectedModelLabel({
      providers: availableProviders,
      selectedProvider,
      selectedModel,
      isLoading,
    }),
  );
  const ModelIcon = useProviderIcon(selectedProvider, serverId);
  const hasSelectedProvider = selectedProvider.trim().length > 0;
  const rootHeader = useMemo(() => ({ title: t("modelSelector.selectModel") }), [t]);

  const open = useCallback(() => {
    Keyboard.dismiss();
    setIsOpen(true);
    onOpen?.();
  }, [onOpen]);

  const close = useCallback(() => {
    setIsModelBrowserOpen(false);
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const openModelBrowser = useCallback(() => {
    Keyboard.dismiss();
    setIsModelBrowserOpen(true);
  }, []);

  const closeModelBrowser = useCallback(() => setIsModelBrowserOpen(false), []);

  const handlePick = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      Keyboard.dismiss();
      setIsModelBrowserOpen(false);
    },
    [onSelect],
  );

  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      close();
    },
    [close, onApplyProfile],
  );

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    open();
  }, [close, isOpen, open]);

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      (pressed || isOpen) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [disabled, isOpen],
  );

  const panel = (
    <ProviderModelPanel
      providers={availableProviders}
      selectedProvider={selectedProvider}
      selectedModel={selectedModel}
      isLoading={isLoading}
      profiles={profiles}
      onPick={handlePick}
      onApplyProfile={onApplyProfile ? handleApplyProfile : undefined}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
      serverId={serverId}
      autoFocusSearch={isWeb && !usesBottomSheet}
    />
  );

  const mobileRootContent = useMemo(
    () => (
      <View style={styles.mobileRootContent} testID="agent-controls-settings-list">
        <View style={styles.controlsContent}>
          <AgentControlTrigger
            icon={ModelIcon}
            surface="sheet"
            label={t("modelSelector.model")}
            value={selectedModelLabel}
            disabled={disabled}
            onPress={openModelBrowser}
            accessibilityLabel={t("modelSelector.selectedModel", { model: selectedModelLabel })}
            testID="agent-controls-model"
          />
          {children}
        </View>
      </View>
    ),
    [ModelIcon, children, disabled, openModelBrowser, selectedModelLabel, t],
  );

  return (
    <>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={toggle}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("modelSelector.selectedModel", { model: selectedModelLabel })}
        testID="combined-model-selector"
        chevron={null}
      >
        {hasSelectedProvider ? (
          <ComposerToolbarGlyph size={glyphSize}>
            <ModelIcon size={glyphSize} color={styles.providerIcon.color} />
          </ComposerToolbarGlyph>
        ) : null}
        <View style={styles.triggerLabels}>
          <Text style={styles.triggerText} numberOfLines={1}>
            {selectedModelLabel}
          </Text>
          {thinkingLabel ? (
            <Text style={styles.triggerThinking} numberOfLines={1}>
              {thinkingLabel}
            </Text>
          ) : null}
        </View>
      </ComboboxTrigger>

      <AdaptiveModalSheet
        header={rootHeader}
        visible={isOpen}
        onClose={close}
        snapPoints={SNAP_POINTS}
        scrollable={false}
        contentStyle={styles.sheetBody}
        testID="agent-controls-model-sheet"
      >
        {usesBottomSheet ? (
          mobileRootContent
        ) : (
          <>
            <View
              style={[styles.modelViewport, styles.fixedModelViewport]}
              testID="agent-controls-model-viewport"
            >
              {isOpen ? panel : null}
            </View>
            <View style={styles.modelViewportDivider} />
            <ScrollView
              style={styles.controlsScroll}
              contentContainerStyle={styles.controlsContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              testID="agent-controls-settings-list"
            >
              {children}
            </ScrollView>
          </>
        )}
      </AdaptiveModalSheet>

      {usesBottomSheet ? (
        <AdaptiveModalSheet
          header={MODEL_PICKER_HEADER}
          visible={isModelBrowserOpen}
          onClose={closeModelBrowser}
          snapPoints={SNAP_POINTS}
          scrollable={false}
          presentation="push"
          contentStyle={styles.sheetBody}
          testID="agent-controls-model-browser-sheet"
        >
          <View
            style={[styles.modelViewport, styles.flexibleModelViewport]}
            testID="agent-controls-model-browser-viewport"
          >
            {isModelBrowserOpen ? panel : null}
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerLabels: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  triggerThinking: {
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  modelViewport: {
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  flexibleModelViewport: {
    flex: 1,
    minHeight: 0,
  },
  fixedModelViewport: {
    height: FIXED_MODEL_VIEWPORT_HEIGHT,
    minHeight: FIXED_MODEL_VIEWPORT_HEIGHT,
  },
  modelViewportDivider: {
    height: 1,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
  },
  controlsScroll: {
    flex: 1,
    minHeight: 0,
  },
  mobileRootContent: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
}));
