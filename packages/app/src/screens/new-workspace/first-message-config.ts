import type { FirstMessageOutboxInput } from "@/composer/outbox/model";
import type { FormPreferences } from "@/hooks/use-form-preferences";
interface ComposerModel {
  selectedProvider: string | null;
  selectedModel: string;
  selectedMode: string;
  selectedThinkingOptionId: string;
  effectiveModelId: string;
  effectiveModeId: string;
  effectiveThinkingOptionId: string;
  featureValues?: Record<string, unknown>;
}

export function buildFirstMessageModel(input: {
  composerState: ComposerModel | null;
  formPreferences: FormPreferences;
  isConnected: boolean;
  useDefaultModel: boolean;
  cwd: string;
}): Pick<FirstMessageOutboxInput, "config" | "modelSelection"> {
  if (input.useDefaultModel) return { modelSelection: "default" };
  const current = input.composerState;
  if (current?.selectedProvider && input.isConnected)
    return {
      config: {
        provider: current.selectedProvider,
        cwd: input.cwd,
        model: current.effectiveModelId || undefined,
        modeId: current.effectiveModeId || undefined,
        thinkingOptionId: current.effectiveThinkingOptionId || undefined,
        featureValues: current.featureValues,
      },
    };
  const provider = current?.selectedProvider || input.formPreferences.provider;
  if (!provider) return { modelSelection: "default" };
  return savedFirstMessageModel(input, provider);
}

function savedFirstMessageModel(
  input: Parameters<typeof buildFirstMessageModel>[0],
  provider: string,
): Pick<FirstMessageOutboxInput, "config"> {
  const current = input.composerState;
  const saved = input.formPreferences.providerPreferences?.[provider];
  const model = current?.selectedModel || saved?.model;
  return {
    config: {
      provider,
      cwd: input.cwd,
      model,
      modeId: current?.selectedMode || saved?.mode,
      thinkingOptionId:
        current?.selectedThinkingOptionId || (model ? saved?.thinkingByModel?.[model] : undefined),
      featureValues: current?.featureValues ?? saved?.featureValues,
    },
  };
}
