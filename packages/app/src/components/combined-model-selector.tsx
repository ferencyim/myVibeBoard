import { useMemo } from "react";
import {
  ProviderModelPicker,
  type PickerFast,
  type PickerThinking,
  type ProviderModelPickerTriggerState,
} from "@/components/provider-model-picker/provider-model-picker";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

interface CombinedModelSelectorProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, modelId: string) => void | Promise<unknown>;
  isLoading: boolean;
  fast?: PickerFast | null;
  renderTrigger?: (input: ProviderModelPickerTriggerState) => React.ReactNode;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: string) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  /** Full-width form-field trigger (schedule form, settings). */
  triggerFill?: boolean;
  /** Effort options of the current model; when present the picker also edits the effort. */
  thinkingOptions?: { id: string; label: string }[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (id: string) => void;
  toolbar?: { glyphSize: number; showCaret: boolean };
}

/** Provider / model / effort selector; the implementation is `provider-model-picker/`. */
export function CombinedModelSelector({
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  toolbar,
  ...rest
}: CombinedModelSelectorProps) {
  const thinking = useMemo<PickerThinking | null>(
    () =>
      thinkingOptions && thinkingOptions.length > 0 && onSelectThinkingOption
        ? {
            options: thinkingOptions,
            selectedId: selectedThinkingOptionId,
            onSelect: onSelectThinkingOption,
          }
        : null,
    [onSelectThinkingOption, selectedThinkingOptionId, thinkingOptions],
  );
  return (
    <ProviderModelPicker
      providers={rest.providers}
      selectedProvider={rest.selectedProvider}
      selectedModel={rest.selectedModel}
      onSelect={rest.onSelect}
      isLoading={rest.isLoading}
      thinking={thinking}
      fast={rest.fast}
      onRetryProvider={rest.onRetryProvider}
      isRetryingProvider={rest.isRetryingProvider}
      disabled={rest.disabled}
      serverId={rest.serverId}
      onOpen={rest.onOpen}
      onClose={rest.onClose}
      renderTrigger={rest.renderTrigger}
      triggerFill={rest.triggerFill}
      glyphSize={toolbar?.glyphSize}
    />
  );
}
