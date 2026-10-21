import type { PaseoApi } from "@getpaseo/client";
import type { Preset } from "../vibe/contract";

export type ModelCatalog = Partial<{ providers: Pick<PaseoApi["providers"], "listModels"> }>;

/**
 * A preset without a model cannot be turned into a "provider/model" spec. Presets created before the
 * model became mandatory are completed with the provider's default model; `note` says so for the card.
 */
export async function ensurePresetModel<P extends Pick<Preset, "name" | "provider" | "model">>(
  paseo: ModelCatalog | null | undefined,
  preset: P,
): Promise<{ preset: P; note: string | null }> {
  if (preset.model.trim()) return { preset, note: null };
  let model: string | undefined;
  try {
    const res = await paseo?.providers?.listModels(preset.provider);
    const models = res?.models?.filter((m) => m.isSelectable !== false) ?? [];
    model = (models.find((m) => m.isDefault) ?? models[0])?.id;
  } catch {
    // no catalog: reported below
  }
  if (!model) {
    throw new Error(
      `预设“${preset.name}”没有填模型，${preset.provider} 也没有默认模型，请编辑预设并选一个模型`,
    );
  }
  return {
    preset: { ...preset, model },
    note: `预设“${preset.name}”没有填模型，改用 ${preset.provider} 的默认模型 ${model}。`,
  };
}
