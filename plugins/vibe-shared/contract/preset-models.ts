import type { Preset, PresetModel } from "./model";

export function presetModels(preset: Preset): PresetModel[] {
  if (preset.models?.length) return preset.models;
  const { provider, model, thinking, permissionMode } = preset;
  return [{ provider, model, thinking, permissionMode }];
}

export function withPresetModel(preset: Preset, candidate: PresetModel): Preset {
  return { ...preset, ...candidate };
}
