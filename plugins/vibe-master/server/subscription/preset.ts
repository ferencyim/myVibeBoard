// Which agent preset the master runs on (WP-109). The setting `presetId` is the only source. An owner
// who never picked one but has the pre-WP-109 provider/model/thinking settings keeps working: the
// matching preset is used (and shown as "migrated") until a preset is chosen on the settings page.

import type { MasterSettings, MasterTarget } from "../../shared/rpc";
import type { Preset } from "../vibe/contract";
import { MasterError, type MasterPaseo } from "../types";
import { resolveTarget } from "./target";

export type PresetSource = "setting" | "migrated" | "none";

type LegacyFields = Pick<MasterSettings, "presetId" | "provider" | "model" | "thinking">;

const bareModel = (model: string, provider: string) =>
  (model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model).trim().toLowerCase();

/** The preset in effect, or null when none is chosen (or the chosen one was deleted). */
export function resolveMasterPreset(
  settings: LegacyFields,
  presets: readonly Preset[],
): { preset: Preset | null; source: PresetSource } {
  const chosen = settings.presetId ? presets.find((p) => p.id === settings.presetId) : undefined;
  if (chosen) return { preset: chosen, source: "setting" };
  if (settings.presetId || !settings.provider) return { preset: null, source: "none" };

  const sameProvider = presets.filter((p) => p.provider === settings.provider);
  const model = bareModel(settings.model, settings.provider);
  const sameModel = model ? sameProvider.filter((p) => bareModel(p.model, p.provider) === model) : sameProvider;
  // "max" meant the highest level of the model; any concrete level must match exactly.
  const thinking = settings.thinking && settings.thinking !== "max" ? settings.thinking : "";
  const exact = thinking ? sameModel.filter((p) => p.thinking === thinking) : sameModel;
  const preset = exact[0] ?? null;
  return preset ? { preset, source: "migrated" } : { preset: null, source: "none" };
}

/** Provider/model/thinking of a preset; an empty model is resolved from the provider catalog. */
export async function targetOfPreset(
  paseo: Pick<MasterPaseo, "providers"> | null,
  preset: Preset,
): Promise<MasterTarget> {
  const thinking = preset.thinking && preset.thinking !== "default" ? preset.thinking : null;
  if (preset.model.trim()) return { provider: preset.provider, model: preset.model, thinking };
  if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
  const resolved = await resolveTarget(paseo, { provider: preset.provider });
  return { ...resolved, thinking };
}
