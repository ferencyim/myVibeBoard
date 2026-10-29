// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { PresetPermissionMode } from "./enums";
import type { TaskTabRole } from "./task";
import type { Preset, PresetModel } from "./model";

export function presetModels(preset: Preset): PresetModel[] {
  if (preset.models?.length) return preset.models;
  const { provider, model, thinking, permissionMode } = preset;
  return [{ provider, model, thinking, permissionMode }];
}

export function withPresetModel(preset: Preset, candidate: PresetModel): Preset {
  return { ...preset, ...candidate };
}

/** Native modeId for a preset permission mode. Only Claude and Codex have a stable set of named
 *  modes; every other provider keeps its own default and receives no modeId (an unknown mode would
 *  break agent creation). */
export function presetModeId(provider: string, mode: PresetPermissionMode): string | undefined {
  const p = provider.toLowerCase();
  if (p !== "claude" && p !== "codex") return undefined;
  if (mode === "full") return p === "claude" ? "bypassPermissions" : "full-access";
  return mode === "auto" ? "auto" : undefined;
}

/** The one source for a task tab's native mode, whether the plugin pre-creates the tab or opens it
 *  on demand. Worker and subagent keep their preset's mode; reviewer and verifier always run
 *  "auto" (read-only by prompt, not by mode); planning tabs keep the provider default. */
export function taskRoleModeId(
  role: TaskTabRole | "subagent",
  provider: string,
  mode: PresetPermissionMode,
): string | undefined {
  if (role === "worker" || role === "subagent") return presetModeId(provider, mode);
  if (role === "reviewer" || role === "verifier") return presetModeId(provider, "auto");
  return undefined;
}
