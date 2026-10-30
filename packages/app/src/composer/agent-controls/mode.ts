import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { AgentModeControlValue } from "@/composer/agent-controls/mode-control";

export function resolveNextAgentModeId({
  modeOptions,
  selectedMode,
}: {
  modeOptions: readonly AgentMode[];
  selectedMode: string | null | undefined;
}): string | null {
  if (modeOptions.length < 2) return null;

  const selectedIndex = modeOptions.findIndex((mode) => mode.id === selectedMode);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const nextIndex = (currentIndex + 1) % modeOptions.length;
  return modeOptions[nextIndex]?.id ?? null;
}

export function resolveAgentControlsMode(agentControls?: DraftAgentControlsProps) {
  return agentControls ? "draft" : "ready";
}

/**
 * An agent the daemon has not loaded reports no runtime modes; the provider definition's modes
 * stand in so the permission choice is still offered (setAgentMode loads the agent on demand).
 */
export function resolveModeControlValue(input: {
  provider: string;
  providerDefinitions: AgentProviderDefinition[];
  availableModes: AgentMode[];
  currentModeId: string | null | undefined;
  onSelectMode: (modeId: string) => void;
  disabled: boolean;
}): AgentModeControlValue | null {
  const definition = input.providerDefinitions[0];
  const live = input.availableModes.length > 0;
  const modeOptions = live ? input.availableModes : (definition?.modes ?? []);
  if (modeOptions.length === 0) return null;
  return {
    provider: input.provider,
    providerDefinitions: input.providerDefinitions,
    modeOptions,
    selectedModeId: input.currentModeId ?? (live ? undefined : definition?.defaultModeId),
    onSelectMode: input.onSelectMode,
    disabled: input.disabled,
  };
}
