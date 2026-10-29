import type { VibeStore } from "./vibe/db";
import { findProjectConfig } from "./vibe/db/project-config";
import { presetModels } from "./vibe/contract";

/** Explicit task model choices are already on the creation request. Default intents resolve live. */
export function resolveMainConfig(
  store: Pick<VibeStore, "projects" | "modelDefaults" | "presets">,
  projectId: string | null,
  rootPath?: string,
) {
  const id =
    (projectId
      ? findProjectConfig(store.projects.list(true), projectId, rootPath)?.defaultPresets.main
      : undefined) ??
    store.modelDefaults.global().main;
  if (!id) return {};
  const preset = store.presets.get(id);
  if (!preset) throw new Error("#1 主会话预设不存在：" + id);
  const model = presetModels(preset)[0];
  if (!model) throw new Error("#1 主会话预设没有模型");
  return {
    config: {
      provider: model.provider,
      model: model.model,
      ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
    },
  };
}
