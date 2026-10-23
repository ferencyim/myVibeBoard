import type { PluginTaskConversationPrepareRequest } from "@getpaseo/plugin/server";
import {
  TaskPresetSnapshotSchema,
  presetModels,
  type Preset,
  type TaskPresetSnapshot,
} from "../vibe/contract";

export function snapshotPreset(preset: Preset): TaskPresetSnapshot {
  return TaskPresetSnapshotSchema.parse({
    presetId: preset.id,
    source: "task",
    models: presetModels(preset),
    environmentKind: preset.environmentKind,
    runtimeEnv: preset.runtimeEnv,
    instructions: preset.instructions,
  });
}

/** Native model selection changes the model, preserving the selected environment and permissions. */
export function nativeModelSnapshot(
  base: TaskPresetSnapshot,
  config: PluginTaskConversationPrepareRequest["recipient"]["config"],
  candidateIndex: number,
): TaskPresetSnapshot {
  const model = base.models[candidateIndex] ?? base.models[0]!;
  if (!config.model) throw new Error("原生模型选择缺少明确模型，请从模型目录重新选择");
  return TaskPresetSnapshotSchema.parse({
    ...base,
    source: "task",
    models: [
      {
        ...model,
        provider: config.provider,
        model: config.model,
        thinking: config.thinkingOptionId ?? "",
      },
    ],
  });
}

export function bootstrapPlannerSnapshot(
  config: PluginTaskConversationPrepareRequest["recipient"]["config"],
): TaskPresetSnapshot {
  return TaskPresetSnapshotSchema.parse({
    presetId: "task-native-planner",
    source: "task",
    models: [
      {
        provider: config.provider,
        model: config.model ?? "",
        thinking: config.thinkingOptionId ?? "",
        permissionMode: "accept-edits",
      },
    ],
    environmentKind: "project-default",
    runtimeEnv: null,
    instructions: "",
  });
}
