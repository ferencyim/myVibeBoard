import { useCallback, useMemo, type ReactNode } from "react";
import type { ModelPickerFieldProps } from "@getpaseo/plugin/client/ui";
import { ProviderModelPicker } from "@/components/provider-model-picker/provider-model-picker";
import { ModelProviderGlyph } from "@/components/model-browser";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import type {
  ProviderSelectorProvider,
  ProviderSelectionModelRow,
} from "@/provider-selection/provider-selection";

/** Full-width provider / model / effort field for plugin settings screens. */
export function ModelPickerField(props: ModelPickerFieldProps) {
  const {
    providers,
    provider,
    model,
    thinking,
    loading = false,
    disabled,
    onSelect,
    onOpen,
  } = props;
  const selectorProviders = useMemo<ProviderSelectorProvider[]>(
    () =>
      providers.map((entry) => {
        const label = entry.label ?? entry.provider;
        const rows: ProviderSelectionModelRow[] = entry.models.map((item) => ({
          favoriteKey: `${entry.provider}:${item.id}`,
          provider: entry.provider,
          providerLabel: label,
          modelId: item.id,
          modelLabel: item.name,
          description: item.id,
          isDefault: item.isDefault,
        }));
        return { id: entry.provider, label, modelSelection: { kind: "models", rows } };
      }),
    [providers],
  );
  const efforts = useMemo(
    () =>
      providers
        .find((entry) => entry.provider === provider)
        ?.models.find((item) => item.id === model)?.thinkingOptions ?? [],
    [providers, provider, model],
  );
  const pickerThinking = useMemo(
    () =>
      efforts.length > 0 && props.onSelectThinking
        ? {
            options: efforts.map((item) => ({ id: item.id, label: item.name })),
            selectedId: thinking || undefined,
            onSelect: (id: string) => void props.onSelectThinking?.(id),
          }
        : null,
    [efforts, thinking, props],
  );
  const effortLabel = efforts.find((item) => item.id === thinking)?.name;
  const leading = useMemo(
    () => (provider ? <ModelProviderGlyph provider={provider} serverId={null} size={16} /> : null),
    [provider],
  );
  const renderTrigger = useCallback(
    (state: {
      selectedModelLabel: string;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => (
      <SelectFieldTrigger
        label={[state.selectedModelLabel, effortLabel].filter(Boolean).join(" · ")}
        isPlaceholder={!model}
        placeholder="选择模型"
        leading={leading}
        disabled={state.disabled}
        active={state.hovered || state.pressed || state.isOpen}
        testID="plugin-model-picker-field"
      />
    ),
    [effortLabel, model, leading],
  );
  return (
    <ProviderModelPicker
      providers={selectorProviders}
      selectedProvider={provider}
      selectedModel={model}
      onSelect={onSelect}
      isLoading={loading}
      thinking={pickerThinking}
      disabled={disabled}
      onOpen={onOpen}
      renderTrigger={renderTrigger}
      triggerFill
    />
  );
}
