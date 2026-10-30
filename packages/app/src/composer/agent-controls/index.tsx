import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  Pressable,
  Keyboard,
  useWindowDimensions,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { Settings2 } from "lucide-react-native";
import { getAgentFeatureIcon, ThinkingIcon } from "@/agent-controls/icons";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import {
  NextTurnBadge,
  type PickerFast,
} from "@/components/provider-model-picker/provider-model-picker";
import { FAST_MODE_FEATURE_ID, PLAN_MODE_FEATURE_ID } from "@/agent-controls/policy";
import {
  resolveNextTurnNotice,
  type NextTurnNotice,
} from "@/components/provider-model-picker/next-turn";
import {
  buildProviderSelectorProviders,
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import {
  AgentModeControl,
  useLiveAgentModeControl,
  type AgentModeControlValue,
} from "@/composer/agent-controls/mode-control";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import {
  getFeatureHighlightColor,
  isFeatureActive,
  getFeatureTooltip,
  getAgentControlHintKey,
  resolveAgentModelSelection,
} from "@/composer/agent-controls/utils";
import { useIsCompactFormFactor } from "@/constants/layout";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  useAgentControlCommandCenterActions,
  type AgentControlCommandCenterSource,
} from "@/command-center/agent-control-registration";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isNative } from "@/constants/platform";
import {
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveComposerToolbarGlyphSize,
  type ComposerControlDensity,
  type ComposerControlPresentation,
} from "@/composer/agent-controls/layout";
import { ComposerControlLayoutProvider } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { AgentControlTrigger } from "@/composer/agent-controls/control";

interface AgentControlOption {
  id: string;
  label: string;
}

type AgentControlSelector = "provider" | "mode" | "model" | "thinking" | `feature-${string}`;

const EMPTY_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [];

interface ControlledAgentControlsProps {
  provider: string;
  providerOptions?: AgentControlOption[];
  selectedProviderId?: string;
  onSelectProvider?: (providerId: string) => void;
  modelOptions?: AgentControlOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  thinkingOptions?: AgentControlOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  modelSelectorProviders?: ProviderSelectorProvider[];
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  modeControl?: AgentModeControlValue | null;
  modelSelectorServerId?: string | null;
  nextTurnNotice?: NextTurnNotice | null;
  isCompactLayout?: boolean;
}

export interface DraftAgentControlsProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider | null;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  isModelLoading: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => void;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  disabled?: boolean;
  modelSelectorServerId?: string | null;
  nextTurnNotice?: NextTurnNotice | null;
  isCompactLayout?: boolean;
}

interface AgentControlsProps {
  agentId: string;
  serverId: string;
  registrationOnly?: boolean;
  onDropdownClose?: () => void;
  isCompactLayout?: boolean;
  hideModeControl?: boolean;
}

function AgentControlCommandCenterRegistration({
  sourceId,
  enabled,
  controls,
}: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  useAgentControlCommandCenterActions({
    sourceId,
    enabled: enabled && isActiveComposer,
    controls,
  });
  return null;
}

function findOptionLabel(
  options: AgentControlOption[] | undefined,
  selectedId: string | undefined,
  fallback: string,
) {
  if (!options || options.length === 0) {
    return fallback;
  }
  const selected = options.find((option) => option.id === selectedId);
  return selected?.label ?? fallback;
}

function toCommandCenterModes(modeControl: AgentModeControlValue | null) {
  if (!modeControl) return undefined;
  return {
    options: modeControl.modeOptions,
    selectedId: modeControl.selectedModeId,
    select: modeControl.onSelectMode,
  };
}

function getModeProviderDefinitions(modeControl: AgentModeControlValue | null) {
  return modeControl?.providerDefinitions ?? EMPTY_AGENT_PROVIDER_DEFINITIONS;
}

function getFeatureIconColor(
  feature: AgentFeature,
  palette: {
    blue: { 400: string };
    green: { 400: string };
    yellow: { 400: string };
  },
  foregroundMuted: string,
): string {
  if (!isFeatureActive(feature)) {
    return foregroundMuted;
  }

  switch (getFeatureHighlightColor(feature.id)) {
    case "blue":
      return palette.blue[400];
    case "green":
      return palette.green[400];
    case "yellow":
      return palette.yellow[400];
    default:
      return foregroundMuted;
  }
}

type ActiveSheet = "thinking" | "features" | null;

function resolveHasAnyControl({
  providerOptions,
  canSelectModel,
  thinkingOptions,
  features,
  hasMode,
}: {
  providerOptions: AgentControlOption[] | undefined;
  canSelectModel: boolean;
  thinkingOptions: AgentControlOption[] | undefined;
  features: AgentFeature[] | undefined;
  hasMode: boolean;
}) {
  return (
    Boolean(providerOptions?.length) ||
    canSelectModel ||
    Boolean(thinkingOptions?.length) ||
    Boolean(features?.length) ||
    hasMode
  );
}

function toComboboxOptions(options: AgentControlOption[] | undefined): ComboboxOption[] {
  return (options ?? []).map((o) => ({ id: o.id, label: o.label }));
}

function toThinkingControlOptions(options: AgentControlOption[] | undefined): AgentControlOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    label: formatThinkingOptionLabel(option),
  }));
}

function buildFallbackModelSelectorProviders(
  provider: string,
  modelOptions: AgentControlOption[] | undefined,
): ProviderSelectorProvider[] {
  if (!modelOptions || modelOptions.length === 0) {
    return [];
  }
  return [
    {
      id: provider,
      label: provider,
      modelSelection: {
        kind: "models",
        rows: modelOptions.map((option) => ({
          favoriteKey: `${provider}:${option.id}`,
          provider,
          providerLabel: provider,
          modelId: option.id,
          modelLabel: option.label,
        })),
      },
    },
  ];
}

function makeBadgePressableStyle(
  baseStyle: StyleProp<ViewStyle>,
  disabledStyle: StyleProp<ViewStyle>,
  disabled: boolean,
  isOpen: boolean,
) {
  return ({ pressed, hovered }: PressableStateCallbackType) => [
    baseStyle,
    hovered && styles.modeBadgeHovered,
    (pressed || isOpen) && styles.modeBadgePressed,
    disabled && disabledStyle,
  ];
}

function pickDesktopModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectModel,
  onSelectProviderAndModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
}) {
  if (onSelectProviderAndModel) {
    onSelectProviderAndModel(nextProviderId, modelId);
    return;
  }
  if (nextProviderId === currentProvider) {
    onSelectModel?.(modelId);
  }
}

type AgentControlsSlice = {
  provider: string;
  cwd: string | null;
  runtimeModelId: string | null;
  model: string | null | undefined;
  features: AgentFeature[] | undefined;
  runtimeThinkingOptionId: string | null;
  thinkingOptionId: string | null | undefined;
  lastUsage: unknown;
  status: string;
  botId: string | null;
} | null;

function selectAgentControlsSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): AgentControlsSlice {
  const currentAgent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
  if (!currentAgent) {
    return null;
  }
  return {
    provider: currentAgent.provider,
    cwd: currentAgent.cwd,
    runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
    model: currentAgent.model,
    features: currentAgent.features,
    runtimeThinkingOptionId: currentAgent.runtimeInfo?.thinkingOptionId ?? null,
    thinkingOptionId: currentAgent.thinkingOptionId,
    lastUsage: currentAgent.lastUsage,
    status: currentAgent.status,
    botId: currentAgent.labels?.["vibe.bot"] ?? null,
  };
}

function resolveSnapshotSelectedEntry(
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
  agentProvider: string | undefined,
) {
  if (!snapshotEntries || !agentProvider) {
    return null;
  }
  return snapshotEntries.find((e) => e.provider === agentProvider) ?? null;
}

function buildAgentProviderDefinitions(
  agentProvider: string | undefined,
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
): AgentProviderDefinition[] {
  const definition = agentProvider
    ? resolveProviderDefinition(agentProvider, snapshotEntries)
    : undefined;
  return definition ? [definition] : [];
}

function buildAgentProviderModels(
  agentProvider: string | undefined,
  models: AgentModelDefinition[] | null,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  if (agentProvider && models) {
    map.set(agentProvider, models);
  }
  return map;
}

function buildOpenChangeHandler(
  selector: AgentControlSelector,
  setOpenSelector: (next: AgentControlSelector | null) => void,
  onDropdownClose?: () => void,
) {
  return (nextOpen: boolean) => {
    setOpenSelector(nextOpen ? selector : null);
    if (!nextOpen) {
      onDropdownClose?.();
    }
  };
}

function ControlledAgentControls({
  provider,
  providerOptions,
  selectedProviderId,
  onSelectProvider,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  isModelLoading = false,
  modelSelectorProviders,
  features: allFeatures,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  modeControl,
  modelSelectorServerId = null,
  nextTurnNotice = null,
  isCompactLayout,
}: ControlledAgentControlsProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const isCompact = isCompactLayout ?? isCompactFormFactor;
  const { fontScale } = useWindowDimensions();
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const [openSelector, setOpenSelector] = useState<AgentControlSelector | null>(null);
  const initialDensity: ComposerControlDensity = isCompact ? "tight" : "full";
  const [density, setDensity] = useState<ComposerControlDensity>(initialDensity);
  const densityRef = useRef<ComposerControlDensity>(initialDensity);
  const availableWidthRef = useRef(0);

  const providerAnchorRef = useRef<View>(null);
  const _modelAnchorRef = useRef<View>(null);
  const thinkingAnchorRef = useRef<View>(null);

  // Fast lives inside the model picker and plan mode only in the mode menu / command center.
  const fast = useMemo<PickerFast | null>(() => {
    const feature = allFeatures?.find(
      (item) => item.id === FAST_MODE_FEATURE_ID && item.type === "toggle",
    );
    if (!feature || !onSetFeature) return null;
    return {
      value: feature.value === true,
      onChange: (value) => onSetFeature(FAST_MODE_FEATURE_ID, value),
    };
  }, [allFeatures, onSetFeature]);
  const features = useMemo(
    () =>
      allFeatures?.filter(
        (item) => item.id !== FAST_MODE_FEATURE_ID && item.id !== PLAN_MODE_FEATURE_ID,
      ),
    [allFeatures],
  );

  const canSelectProvider = Boolean(
    onSelectProvider && providerOptions && providerOptions.length > 0,
  );
  const canSelectModel = Boolean(onSelectModel);
  const canSelectThinking = Boolean(
    onSelectThinkingOption && thinkingOptions && thinkingOptions.length > 0,
  );

  const displayProvider = findOptionLabel(
    providerOptions,
    selectedProviderId,
    t("agentControls.provider.fallback"),
  );
  const formattedThinkingOptions = useMemo(
    () => toThinkingControlOptions(thinkingOptions),
    [thinkingOptions],
  );
  const displayThinking = findOptionLabel(
    formattedThinkingOptions,
    selectedThinkingOptionId,
    formattedThinkingOptions[0]?.label ?? t("agentControls.thinking.unknown"),
  );

  const hasAnyControl = resolveHasAnyControl({
    providerOptions,
    canSelectModel,
    thinkingOptions,
    features,
    hasMode: modeControl !== null && modeControl !== undefined,
  });
  const featureControls = useMemo(
    () =>
      (features ?? []).map((feature) => {
        if (feature.type === "toggle") return { type: "toggle" as const };
        const selectedOption = feature.options.find((option) => option.id === feature.value);
        return {
          type: "select" as const,
          label: selectedOption?.label ?? feature.label,
        };
      }),
    [features],
  );
  const controlPresence = useMemo(
    () => ({
      hasModel: canSelectModel,
      hasThinking: canSelectThinking,
      hasMode: modeControl !== null && modeControl !== undefined,
      features: featureControls,
      fontScale,
    }),
    [canSelectModel, canSelectThinking, featureControls, fontScale, modeControl],
  );
  const presentation = useMemo(() => resolveComposerControlPresentation(density), [density]);
  const layoutContextValue = useMemo(
    () => ({
      glyphSize: resolveComposerToolbarGlyphSize(isNative ? "native" : "web"),
      presentation,
    }),
    [presentation],
  );

  const updateDensityForWidth = useCallback(
    (availableWidth: number) => {
      const nextDensity = resolveComposerControlDensity({
        availableWidth,
        currentDensity: densityRef.current,
        controls: controlPresence,
      });
      if (nextDensity === densityRef.current) return;
      densityRef.current = nextDensity;
      setDensity(nextDensity);
    },
    [controlPresence],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const availableWidth = readMeasuredWidth(event);
      if (availableWidth === null) return;
      availableWidthRef.current = availableWidth;
      updateDensityForWidth(availableWidth);
    },
    [updateDensityForWidth],
  );

  useEffect(() => {
    if (availableWidthRef.current > 0) {
      updateDensityForWidth(availableWidthRef.current);
    }
  }, [updateDensityForWidth]);

  const modelDisabled = disabled;

  const comboboxProviderOptions = useMemo<ComboboxOption[]>(
    () => toComboboxOptions(providerOptions),
    [providerOptions],
  );
  const fallbackModelSelectorProviders = useMemo(
    () => buildFallbackModelSelectorProviders(provider, modelOptions),
    [modelOptions, provider],
  );
  const effectiveModelSelectorProviders = modelSelectorProviders ?? fallbackModelSelectorProviders;
  const comboboxThinkingOptions = useMemo<ComboboxOption[]>(
    () => toComboboxOptions(formattedThinkingOptions),
    [formattedThinkingOptions],
  );

  const renderThinkingOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean; onPress: () => void }) => (
      <ThinkingComboboxOption
        option={args.option}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        iconColor={theme.colors.foreground}
      />
    ),
    [theme.colors.foreground],
  );

  const handleOpenChange = useCallback(
    (selector: AgentControlSelector) =>
      buildOpenChangeHandler(selector, setOpenSelector, onDropdownClose),
    [onDropdownClose],
  );
  const handleSheetOpenChange = useCallback(
    (selector: AgentControlSelector) => (nextOpen: boolean) => {
      setOpenSelector(nextOpen ? selector : null);
    },
    [],
  );

  const handleProviderPress = useCallback(() => {
    handleOpenChange("provider")(openSelector !== "provider");
  }, [handleOpenChange, openSelector]);

  const handleThinkingPress = useCallback(() => {
    handleOpenChange("thinking")(openSelector !== "thinking");
  }, [handleOpenChange, openSelector]);

  const handleProviderOpenChange = useMemo(() => handleOpenChange("provider"), [handleOpenChange]);
  const handleThinkingOpenChange = useMemo(() => handleOpenChange("thinking"), [handleOpenChange]);

  const handleProviderSelect = useCallback(
    (id: string) => onSelectProvider?.(id),
    [onSelectProvider],
  );
  const handleThinkingSelect = useCallback(
    (id: string) => onSelectThinkingOption?.(id),
    [onSelectThinkingOption],
  );

  const handleDesktopModelSelect = useCallback(
    (nextProviderId: string, modelId: string) => {
      pickDesktopModel({
        nextProviderId,
        modelId,
        currentProvider: provider,
        onSelectModel,
        onSelectProviderAndModel,
      });
    },
    [onSelectModel, onSelectProviderAndModel, provider],
  );

  const providerPressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeBadge,
        styles.disabledBadge,
        disabled || !canSelectProvider,
        openSelector === "provider",
      ),
    [canSelectProvider, disabled, openSelector],
  );

  const handleOpenSheet = useCallback((sheet: Exclude<ActiveSheet, null>) => {
    Keyboard.dismiss();
    setActiveSheet(sheet);
  }, []);

  const handleCloseSheet = useCallback(() => {
    setActiveSheet(null);
    if (!isCompact) onDropdownClose?.();
  }, [isCompact, onDropdownClose]);

  if (!hasAnyControl) {
    return null;
  }

  return (
    <ComposerControlLayoutProvider value={layoutContextValue}>
      <View style={styles.container} onLayout={handleLayout}>
        <DesktopAgentControlsContent
          provider={provider}
          providerOptions={providerOptions}
          selectedProviderId={selectedProviderId}
          modelOptions={modelOptions}
          selectedModelId={selectedModelId}
          thinkingOptions={formattedThinkingOptions}
          selectedThinkingOptionId={selectedThinkingOptionId}
          features={features}
          onSetFeature={onSetFeature}
          onDropdownClose={onDropdownClose}
          onModelSelectorOpen={onModelSelectorOpen}
          onRetryModelProvider={onRetryModelProvider}
          isRetryingModelProvider={isRetryingModelProvider}
          disabled={disabled}
          isModelLoading={isModelLoading}
          canSelectProvider={canSelectProvider}
          canSelectModel={canSelectModel}
          canSelectThinking={canSelectThinking}
          modelSelectorProviders={effectiveModelSelectorProviders}
          modelDisabled={modelDisabled}
          comboboxProviderOptions={comboboxProviderOptions}
          comboboxThinkingOptions={comboboxThinkingOptions}
          displayProvider={displayProvider}
          displayThinking={displayThinking}
          openSelector={openSelector}
          providerAnchorRef={providerAnchorRef}
          thinkingAnchorRef={thinkingAnchorRef}
          providerPressableStyle={providerPressableStyle}
          handleProviderPress={handleProviderPress}
          handleThinkingPress={handleThinkingPress}
          handleProviderSelect={handleProviderSelect}
          handleThinkingSelect={handleThinkingSelect}
          handleDesktopModelSelect={handleDesktopModelSelect}
          handleProviderOpenChange={handleProviderOpenChange}
          handleThinkingOpenChange={handleThinkingOpenChange}
          handleOpenChange={handleOpenChange}
          handleNestedOpenChange={handleSheetOpenChange}
          renderThinkingOption={renderThinkingOption}
          modeControl={modeControl}
          presentation={presentation}
          glyphSize={layoutContextValue.glyphSize}
          activeSheet={activeSheet}
          handleOpenSheet={handleOpenSheet}
          handleCloseSheet={handleCloseSheet}
          modelSelectorServerId={modelSelectorServerId}
          nextTurnNotice={nextTurnNotice}
          fast={fast}
        />
      </View>
    </ComposerControlLayoutProvider>
  );
}

interface DesktopAgentControlsContentProps {
  provider: string;
  providerOptions?: AgentControlOption[];
  selectedProviderId?: string;
  modelOptions?: AgentControlOption[];
  selectedModelId?: string;
  thinkingOptions?: AgentControlOption[];
  selectedThinkingOptionId?: string;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider: boolean;
  disabled: boolean;
  isModelLoading: boolean;
  canSelectProvider: boolean;
  canSelectModel: boolean;
  canSelectThinking: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  modelDisabled: boolean;
  comboboxProviderOptions: ComboboxOption[];
  comboboxThinkingOptions: ComboboxOption[];
  displayProvider: string;
  displayThinking: string;
  openSelector: AgentControlSelector | null;
  providerAnchorRef: RefObject<View | null>;
  thinkingAnchorRef: RefObject<View | null>;
  providerPressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleProviderPress: () => void;
  handleThinkingPress: () => void;
  handleProviderSelect: (id: string) => void;
  handleThinkingSelect: (id: string) => void;
  handleDesktopModelSelect: (providerId: string, modelId: string) => void;
  handleProviderOpenChange: (open: boolean) => void;
  handleThinkingOpenChange: (open: boolean) => void;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  handleNestedOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  renderThinkingOption: (args: {
    option: ComboboxOption;
    selected: boolean;
    active: boolean;
    onPress: () => void;
  }) => ReactElement;
  modeControl?: AgentModeControlValue | null;
  presentation: ComposerControlPresentation;
  glyphSize: number;
  activeSheet: ActiveSheet;
  handleOpenSheet: (sheet: Exclude<ActiveSheet, null>) => void;
  handleCloseSheet: () => void;
  modelSelectorServerId: string | null;
  nextTurnNotice: NextTurnNotice | null;
  fast: PickerFast | null;
}

const DESKTOP_SEARCH_THRESHOLD = 6;

function DesktopAgentControlsContent(props: DesktopAgentControlsContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    provider,
    providerOptions,
    selectedProviderId,
    selectedModelId,
    thinkingOptions,
    selectedThinkingOptionId,
    features,
    onSetFeature,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    disabled,
    isModelLoading,
    canSelectProvider,
    canSelectModel,
    canSelectThinking,
    modelSelectorProviders,
    modelDisabled,
    comboboxProviderOptions,
    comboboxThinkingOptions,
    displayProvider,
    displayThinking,
    openSelector,
    providerAnchorRef,
    thinkingAnchorRef,
    providerPressableStyle,
    handleProviderPress,
    handleThinkingPress,
    handleProviderSelect,
    handleThinkingSelect,
    handleDesktopModelSelect,
    handleProviderOpenChange,
    handleThinkingOpenChange,
    handleOpenChange,
    handleNestedOpenChange,
    renderThinkingOption,
    modeControl,
    presentation,
    glyphSize,
    activeSheet,
    handleOpenSheet,
    handleCloseSheet,
    modelSelectorServerId,
    nextTurnNotice,
    fast,
  } = props;
  const modelToolbar = useMemo(
    () => ({ glyphSize, showCaret: presentation.showCarets }),
    [glyphSize, presentation.showCarets],
  );
  const featuresSheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("agentControls.features.title") }),
    [t],
  );
  const handleOpenFeatures = useCallback(() => handleOpenSheet("features"), [handleOpenSheet]);
  return (
    <>
      {providerOptions && providerOptions.length > 0 ? (
        <>
          <ComboboxTrigger
            ref={providerAnchorRef}
            collapsable={false}
            disabled={disabled || !canSelectProvider}
            onPress={handleProviderPress}
            style={providerPressableStyle}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.provider.select")}
            testID="agent-provider-selector"
          >
            <Text style={styles.modeBadgeText}>{displayProvider}</Text>
          </ComboboxTrigger>
          <Combobox
            options={comboboxProviderOptions}
            value={selectedProviderId ?? ""}
            onSelect={handleProviderSelect}
            searchable={comboboxProviderOptions.length > DESKTOP_SEARCH_THRESHOLD}
            open={openSelector === "provider"}
            onOpenChange={handleProviderOpenChange}
            anchorRef={providerAnchorRef}
            desktopPlacement="top-start"
          />
        </>
      ) : null}

      {nextTurnNotice ? (
        <NextTurnBadge running={nextTurnNotice.running} next={nextTurnNotice.next} />
      ) : null}

      {canSelectModel ? (
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="ref">
            <View style={styles.modelControl}>
              <CombinedModelSelector
                providers={modelSelectorProviders}
                selectedProvider={provider}
                selectedModel={selectedModelId ?? ""}
                onSelect={handleDesktopModelSelect}
                isLoading={isModelLoading}
                disabled={modelDisabled}
                onOpen={onModelSelectorOpen}
                onClose={onDropdownClose}
                onRetryProvider={onRetryModelProvider}
                isRetryingProvider={isRetryingModelProvider}
                serverId={modelSelectorServerId}
                fast={fast}
                thinkingOptions={thinkingOptions}
                selectedThinkingOptionId={selectedThinkingOptionId}
                onSelectThinkingOption={canSelectThinking ? handleThinkingSelect : undefined}
                toolbar={modelToolbar}
              />
            </View>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{t(getAgentControlHintKey("model"))}</Text>
          </TooltipContent>
        </Tooltip>
      ) : null}

      {!canSelectModel && thinkingOptions && thinkingOptions.length > 0 ? (
        <>
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger asChild triggerRefProp="ref">
              <AgentControlTrigger
                ref={thinkingAnchorRef}
                icon={ThinkingIcon}
                surface="toolbar"
                label={t("agentControls.thinking.title")}
                value={displayThinking}
                showToolbarLabel={presentation.showThinkingLabel}
                showCaret={presentation.showCarets}
                open={openSelector === "thinking"}
                disabled={disabled || !canSelectThinking}
                onPress={handleThinkingPress}
                accessibilityLabel={t("agentControls.thinking.selectWithValue", {
                  value: displayThinking,
                })}
                testID="agent-thinking-selector"
              />
            </TooltipTrigger>
            <TooltipContent side="top" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t(getAgentControlHintKey("thinking"))}</Text>
            </TooltipContent>
          </Tooltip>
          <Combobox
            options={comboboxThinkingOptions}
            value={selectedThinkingOptionId ?? ""}
            onSelect={handleThinkingSelect}
            searchable={comboboxThinkingOptions.length > DESKTOP_SEARCH_THRESHOLD}
            open={openSelector === "thinking"}
            onOpenChange={handleThinkingOpenChange}
            anchorRef={thinkingAnchorRef}
            desktopPlacement="top-start"
            desktopMinWidth={200}
            renderOption={renderThinkingOption}
          />
        </>
      ) : null}

      {modeControl ? <AgentModeControl {...modeControl} onClose={onDropdownClose} /> : null}

      {presentation.aggregateFeatures && features?.length ? (
        <>
          <Pressable
            onPress={handleOpenFeatures}
            disabled={disabled}
            style={styles.modeIconBadge}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.features.open")}
            testID="agent-controls-features"
          >
            <ComposerToolbarGlyph size={glyphSize}>
              <Settings2 size={glyphSize} color={theme.colors.foregroundMuted} />
            </ComposerToolbarGlyph>
          </Pressable>
          <AdaptiveModalSheet
            header={featuresSheetHeader}
            visible={activeSheet === "features"}
            onClose={handleCloseSheet}
            testID="agent-features-sheet"
          >
            {features.map((feature) => (
              <SheetFeatureItem
                key={`feature-${feature.id}`}
                feature={feature}
                disabled={disabled}
                openSelector={openSelector}
                handleOpenChange={handleNestedOpenChange}
                onSetFeature={onSetFeature}
              />
            ))}
          </AdaptiveModalSheet>
        </>
      ) : (
        features?.map((feature) => (
          <DesktopFeatureItem
            key={`feature-${feature.id}`}
            feature={feature}
            disabled={disabled}
            openSelector={openSelector}
            handleOpenChange={handleOpenChange}
            onSetFeature={onSetFeature}
            onActionComplete={onDropdownClose}
          />
        ))
      )}
    </>
  );
}

function DesktopFeatureItem({
  feature,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
  onActionComplete,
}: {
  feature: AgentFeature;
  disabled: boolean;
  openSelector: AgentControlSelector | null;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
  onActionComplete?: () => void;
}) {
  const { theme } = useUnistyles();
  const featureSelector: AgentControlSelector = `feature-${feature.id}`;
  const featureAnchorRef = useRef<View>(null);

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );
  const handleSelectPress = useCallback(
    () => handleFeatureOpenChange(openSelector !== featureSelector),
    [featureSelector, handleFeatureOpenChange, openSelector],
  );

  const handleTogglePress = useCallback(() => {
    if (feature.type === "toggle") {
      onSetFeature?.(feature.id, !feature.value);
      onActionComplete?.();
    }
  }, [feature, onActionComplete, onSetFeature]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, optionId);
    },
    [feature.id, onSetFeature],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () =>
      feature.type === "select"
        ? feature.options.map((option) => ({ id: option.id, label: option.label }))
        : [],
    [feature],
  );

  if (feature.type === "toggle") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    return (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            icon={FeatureIcon}
            iconColor={getFeatureIconColor(
              feature,
              theme.colors.palette,
              theme.colors.foregroundMuted,
            )}
            surface="toolbar"
            label={feature.label}
            showToolbarLabel={false}
            disabled={disabled}
            onPress={handleTogglePress}
            accessibilityLabel={getFeatureTooltip(feature)}
            testID={`agent-feature-${feature.id}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{getFeatureTooltip(feature)}</Text>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (feature.type === "select") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    const iconOnly = feature.desktopTrigger === "icon";
    const tooltip = iconOnly
      ? `${feature.label}: ${selectedOption?.label ?? feature.label}`
      : getFeatureTooltip(feature);
    return (
      <>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="ref">
            <AgentControlTrigger
              ref={featureAnchorRef}
              icon={FeatureIcon}
              iconColor={getFeatureIconColor(
                feature,
                theme.colors.palette,
                theme.colors.foregroundMuted,
              )}
              surface="toolbar"
              label={feature.label}
              value={selectedOption?.label ?? feature.label}
              showToolbarLabel={!iconOnly}
              open={openSelector === featureSelector}
              disabled={disabled}
              onPress={handleSelectPress}
              accessibilityLabel={tooltip}
              testID={`agent-feature-${feature.id}`}
            />
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{tooltip}</Text>
          </TooltipContent>
        </Tooltip>
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          desktopPlacement="top-start"
        />
      </>
    );
  }

  return null;
}

function SheetFeatureItem({
  feature,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
}: {
  feature: AgentFeature;
  disabled: boolean;
  openSelector: AgentControlSelector | null;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const featureSelector: AgentControlSelector = `feature-${feature.id}`;
  const featureAnchorRef = useRef<View>(null);

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );
  const handleSelectPress = useCallback(
    () => handleFeatureOpenChange(openSelector !== featureSelector),
    [featureSelector, handleFeatureOpenChange, openSelector],
  );
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: feature.label }), [feature.label]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, feature.type === "toggle" ? optionId === "true" : optionId);
    },
    [feature.id, feature.type, onSetFeature],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(() => {
    if (feature.type === "select") {
      return feature.options.map((option) => ({ id: option.id, label: option.label }));
    }
    return [
      { id: "true", label: t("agentControls.features.on") },
      { id: "false", label: t("agentControls.features.off") },
    ];
  }, [feature, t]);

  if (feature.type === "toggle") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    return (
      <>
        <AgentControlTrigger
          ref={featureAnchorRef}
          icon={FeatureIcon}
          iconColor={getFeatureIconColor(
            feature,
            theme.colors.palette,
            theme.colors.foregroundMuted,
          )}
          surface="sheet"
          label={feature.label}
          value={feature.value ? t("agentControls.features.on") : t("agentControls.features.off")}
          open={openSelector === featureSelector}
          disabled={disabled}
          onPress={handleSelectPress}
          accessibilityLabel={getFeatureTooltip(feature)}
          testID={`agent-feature-${feature.id}`}
        />
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          presentation="push"
          searchable={false}
          header={sheetHeader}
        />
      </>
    );
  }

  if (feature.type === "select") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    return (
      <>
        <AgentControlTrigger
          ref={featureAnchorRef}
          icon={FeatureIcon}
          iconColor={getFeatureIconColor(
            feature,
            theme.colors.palette,
            theme.colors.foregroundMuted,
          )}
          surface="sheet"
          label={feature.label}
          value={selectedOption?.label ?? feature.label}
          open={openSelector === featureSelector}
          disabled={disabled}
          onPress={handleSelectPress}
          accessibilityLabel={getFeatureTooltip(feature)}
          testID={`agent-feature-${feature.id}`}
        />
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          presentation="push"
          header={sheetHeader}
        />
      </>
    );
  }

  return null;
}

function ThinkingComboboxOption({
  option,
  selected,
  active,
  onPress,
  iconColor,
}: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  iconColor: string;
}) {
  const leadingSlot = useMemo(() => <ThinkingIcon size={16} color={iconColor} />, [iconColor]);
  return (
    <ComboboxItem
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

// oxlint-disable-next-line complexity
export const AgentControls = memo(function AgentControls({
  agentId,
  serverId,
  registrationOnly = false,
  onDropdownClose,
  isCompactLayout,
  hideModeControl = false,
}: AgentControlsProps) {
  const { updatePreferences } = useFormPreferences();
  const agent = useSessionStore(
    useShallow((state) => selectAgentControlsSlice(state, serverId, agentId)),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();
  const modeControl = useLiveAgentModeControl(serverId, agentId);
  const commandCenterModes = toCommandCenterModes(modeControl);
  const modeProviderDefinitions = getModeProviderDefinitions(modeControl);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: agent?.cwd });

  const snapshotSelectedEntry = useMemo(
    () => resolveSnapshotSelectedEntry(snapshotEntries, agent?.provider),
    [snapshotEntries, agent?.provider],
  );

  const models = filterSelectableModels(snapshotSelectedEntry?.models ?? null);
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";

  const agentProviderDefinitions = useMemo(
    () => buildAgentProviderDefinitions(agent?.provider, snapshotEntries),
    [agent?.provider, snapshotEntries],
  );

  const agentProviderModels = useMemo(
    () => buildAgentProviderModels(agent?.provider, models),
    [agent?.provider, models],
  );
  // Every selectable provider is listed so the live picker shows the same catalog as the draft one.
  const agentModelSelectorProviders = useMemo(() => {
    const selectable = buildSelectableProviderSelectorProviders(snapshotEntries);
    if (selectable.some((entry) => entry.id === agent?.provider)) return selectable;
    if (snapshotSelectedEntry) {
      return buildSelectableProviderSelectorProviders([snapshotSelectedEntry]);
    }
    return buildProviderSelectorProviders({
      providerDefinitions: agentProviderDefinitions,
      modelsByProvider: agentProviderModels,
    });
  }, [
    agent?.provider,
    agentProviderDefinitions,
    agentProviderModels,
    snapshotEntries,
    snapshotSelectedEntry,
  ]);

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    runtimeThinkingOptionId: agent?.runtimeThinkingOptionId,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const nextTurnNotice = resolveNextTurnNotice({
    isRunning: agent?.status === "running",
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    runtimeThinkingId: agent?.runtimeThinkingOptionId,
    configuredThinkingId: agent?.thinkingOptionId,
    labelOf: (modelId) => models?.find((model) => model.id === modelId)?.label ?? modelId,
  });

  const modelOptions = useMemo<AgentControlOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [models]);

  const thinkingOptions = useMemo<AgentControlOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: formatThinkingOptionLabel(option),
    }));
  }, [modelSelection.thinkingOptions]);

  const agentProvider = agent?.provider;
  const activeModelId = modelSelection.activeModelId;

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      try {
        await client.setAgentModel(agentId, modelId);
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: { model: modelId },
          }),
        );
      } catch (error) {
        console.warn("[AgentControls] setAgentModel or persist preference failed", error);
        toast.error(toErrorMessage(error));
      }
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );
  // A running agent is one provider's process, so another provider's model continues the
  // conversation elsewhere: bots hand over through vibe-bots (applied when idle), other
  // sessions through the switch-provider plugin once the current turn has ended.
  const navigation = usePluginHostNavigation(serverId);
  const botId = agent?.botId ?? null;
  const isRunning = agent?.status === "running";
  const pendingSwitch = useRef<{ provider: string; modelId: string } | null>(null);
  const switchProvider = useCallback(
    async (nextProvider: string, modelId: string) => {
      if (!client) return;
      try {
        if (botId) {
          await client.invokePluginRpc("vibe-bots", "bots.update", {
            id: botId,
            patch: { provider: nextProvider, model: modelId, thinking: "", presetId: null },
          });
          toast.show("已切换，空闲后生效");
          return;
        }
        const created = (await client.invokePluginRpc("switch-provider", "session.switch", {
          agentId,
          provider: nextProvider,
          modelId,
        })) as { agentId: string };
        navigation.openAgent({ agentId: created.agentId, serverId });
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [agentId, botId, client, navigation, serverId, toast],
  );
  const handleSelectProviderAndModel = useCallback(
    (nextProvider: AgentProvider, modelId: string) => {
      if (nextProvider === agentProvider) return handleSelectModel(modelId);
      if (isRunning && !botId) {
        pendingSwitch.current = { provider: nextProvider, modelId };
        toast.show("本轮结束后切换");
        return undefined;
      }
      return switchProvider(nextProvider, modelId);
    },
    [agentProvider, botId, handleSelectModel, isRunning, switchProvider, toast],
  );
  useEffect(() => {
    if (isRunning || !pendingSwitch.current) return;
    const pending = pendingSwitch.current;
    pendingSwitch.current = null;
    void switchProvider(pending.provider, pending.modelId);
  }, [isRunning, switchProvider]);
  const handleSelectCommandCenterModel = handleSelectProviderAndModel;

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      if (activeModelId) {
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: activeModelId,
              thinkingByModel: {
                [activeModelId]: thinkingOptionId,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentControls] persist thinking preference failed", error);
        });
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[AgentControls] setAgentThinkingOption failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [activeModelId, agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleSetFeature = useCallback(
    (featureId: string, value: unknown) => {
      if (!client || !agentProvider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: agentProvider,
          updates: {
            featureValues: {
              [featureId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[AgentControls] persist feature preference failed", error);
      });
      void client.setAgentFeature(agentId, featureId, value).catch((error) => {
        console.warn("[AgentControls] setAgentFeature failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: agentId,
      provider: agentProvider,
      providerDefinitions: modeProviderDefinitions,
      models: {
        providers: agentModelSelectorProviders,
        selectedProvider: agentProvider,
        selectedModelId: activeModelId,
        select: handleSelectCommandCenterModel,
      },
      thinking: {
        options: modelSelection.thinkingOptions,
        selectedId: modelSelection.selectedThinkingId,
        select: handleSelectThinkingOption,
      },
      modes: commandCenterModes,
      features: {
        list: agent?.features,
        set: handleSetFeature,
      },
    }),
    [
      activeModelId,
      agent?.features,
      agentId,
      agentModelSelectorProviders,
      agentProvider,
      commandCenterModes,
      handleSelectCommandCenterModel,
      handleSelectThinkingOption,
      handleSetFeature,
      modeProviderDefinitions,
      modelSelection.selectedThinkingId,
      modelSelection.thinkingOptions,
      serverId,
    ],
  );

  const commandCenterRegistration = (
    <AgentControlCommandCenterRegistration
      sourceId={`agent:${serverId}:${agentId}`}
      enabled={Boolean(client)}
      controls={commandCenterControls}
    />
  );

  const handleModelSelectorOpen = useCallback(() => {
    refetchSnapshotIfStale(agentProvider);
  }, [agentProvider, refetchSnapshotIfStale]);

  const handleRetryModelProvider = useCallback(
    (provider: AgentProvider) => {
      void refreshSnapshot([provider]);
    },
    [refreshSnapshot],
  );

  if (!agent) {
    return null;
  }

  if (registrationOnly) return commandCenterRegistration;

  return (
    <>
      {commandCenterRegistration}
      <ControlledAgentControls
        provider={agent.provider}
        modelSelectorProviders={agentModelSelectorProviders}
        modelOptions={modelOptions}
        selectedModelId={modelSelection.activeModelId ?? undefined}
        onSelectModel={handleSelectModel}
        onSelectProviderAndModel={handleSelectProviderAndModel}
        thinkingOptions={thinkingOptions.length > 0 ? thinkingOptions : undefined}
        selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
        onSelectThinkingOption={handleSelectThinkingOption}
        features={agent.features}
        onSetFeature={handleSetFeature}
        isModelLoading={snapshotIsLoading || selectedProviderIsLoading}
        onModelSelectorOpen={handleModelSelectorOpen}
        onRetryModelProvider={handleRetryModelProvider}
        isRetryingModelProvider={snapshotIsRefreshing}
        onDropdownClose={onDropdownClose}
        disabled={!client}
        modeControl={hideModeControl ? null : modeControl}
        modelSelectorServerId={serverId}
        nextTurnNotice={nextTurnNotice}
        isCompactLayout={isCompactLayout}
      />
    </>
  );
});

export function LiveAgentModeControl({
  agentId,
  serverId,
  onClose,
}: {
  agentId: string;
  serverId: string;
  onClose?: () => void;
}) {
  const modeControl = useLiveAgentModeControl(serverId, agentId);
  return modeControl ? (
    <AgentModeControl {...modeControl} surface="sheet" onClose={onClose} />
  ) : null;
}

export function DraftAgentControls({
  providerDefinitions,
  selectedProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  onSelectModel,
  isModelLoading: _isModelLoading,
  modelSelectorProviders,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  disabled = false,
  modelSelectorServerId = null,
  isCompactLayout,
}: DraftAgentControlsProps) {
  const mappedThinkingOptions = useMemo<AgentControlOption[]>(() => {
    return toThinkingControlOptions(thinkingOptions);
  }, [thinkingOptions]);

  const effectiveSelectedThinkingOption =
    selectedThinkingOptionId || mappedThinkingOptions[0]?.id || undefined;

  const modelOptions = useMemo<AgentControlOption[]>(
    () =>
      models.map((model) => ({
        id: model.id,
        label: model.label,
      })),
    [models],
  );

  const modeControl = useMemo<AgentModeControlValue | null>(
    () =>
      selectedProvider && modeOptions.length > 0
        ? {
            provider: selectedProvider,
            providerDefinitions,
            modeOptions,
            selectedModeId: selectedMode,
            onSelectMode,
            disabled,
          }
        : null,
    [selectedProvider, providerDefinitions, modeOptions, selectedMode, onSelectMode, disabled],
  );

  return (
    <ControlledAgentControls
      provider={selectedProvider ?? ""}
      modelSelectorProviders={modelSelectorProviders}
      modelOptions={modelOptions}
      selectedModelId={selectedModel}
      onSelectModel={onSelectModel}
      onSelectProviderAndModel={onSelectProviderAndModel}
      isModelLoading={isAllModelsLoading}
      thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
      selectedThinkingOptionId={effectiveSelectedThinkingOption}
      onSelectThinkingOption={onSelectThinkingOption}
      features={features}
      onSetFeature={onSetFeature}
      onDropdownClose={onDropdownClose}
      onModelSelectorOpen={onModelSelectorOpen}
      onRetryModelProvider={onRetryModelProvider}
      isRetryingModelProvider={isRetryingModelProvider}
      disabled={disabled}
      modeControl={modeControl}
      modelSelectorServerId={modelSelectorServerId}
      isCompactLayout={isCompactLayout}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    overflow: "hidden",
  },
  modeBadge: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modelControl: {
    minWidth: 0,
    flexShrink: 1,
  },
  toolbarCaret: {
    width: 14,
    height: 14,
    flexShrink: 0,
  },
  modeIconBadge: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
    flexShrink: 0,
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  modeBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabledBadge: {
    opacity: 0.5,
  },
  modeBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  combinedSheetControls: {
    gap: theme.spacing[1],
  },
}));
