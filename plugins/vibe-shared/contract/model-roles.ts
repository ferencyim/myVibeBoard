// Seven task roles. Task choices override project defaults, then global defaults.
// Card adapters below remain until the WP-114 cutover.

import { z } from "zod";
import { PresetEnvironmentKindSchema, PresetPermissionModeSchema, type RoleHint } from "./enums";
import { presetModels } from "./preset-models";
import type { Preset } from "./model";
import type { TaskPlan } from "./task";

export const MODEL_ROLES = [
  "scout",
  "planner",
  "plan_reviewer",
  "worker",
  "subagent",
  "reviewer",
  "verifier",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const ModelRoleSchema = z.enum(MODEL_ROLES);

/** Missing key inherits; a preset ID selects; null disables an optional role. */
export const ModelDefaultsSchema = z.object({
  scout: z.string().nullable().optional(),
  planner: z.string().optional(),
  plan_reviewer: z.string().nullable().optional(),
  worker: z.string().optional(),
  subagent: z.string().optional(),
  reviewer: z.string().nullable().optional(),
  verifier: z.string().optional(),
});
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

export type CardModelField =
  | "scoutPresetId"
  | "plannerPresetId"
  | "planReviewerPresetId"
  | "presetId"
  | "subagentPresetId"
  | "reviewerPresetId"
  | "verifierPresetId";

/** The card field that holds each job's pick. `presetId` is the main agent. */
export const CARD_MODEL_FIELD: Record<ModelRole, CardModelField> = {
  scout: "scoutPresetId",
  planner: "plannerPresetId",
  plan_reviewer: "planReviewerPresetId",
  worker: "presetId",
  subagent: "subagentPresetId",
  reviewer: "reviewerPresetId",
  verifier: "verifierPresetId",
};

/** The preset purpose the pickers filter by. */
export const MODEL_ROLE_HINT: Record<ModelRole, RoleHint> = {
  scout: "scout",
  planner: "planner",
  plan_reviewer: "reviewer",
  worker: "worker",
  subagent: "worker",
  reviewer: "reviewer",
  verifier: "verifier",
};

/**
 * Jobs that are skipped when the card has no pick (不探路 / 不复核): their defaults only prefill new
 * cards. Every other job falls back to the defaults at run time too.
 */
export const SKIPPABLE_ROLES: readonly ModelRole[] = ["scout", "reviewer"];

export type ModelSource = "card" | "project" | "global";

export interface ResolvedModel {
  presetId: string | null;
  source: ModelSource | null;
}

/** Keep known preset IDs and explicit optional-role disables from settings or JSON columns. */
export function cleanDefaults(value: unknown): ModelDefaults {
  const parsed = ModelDefaultsSchema.safeParse(value);
  if (!parsed.success) return {};
  const out: ModelDefaults = {};
  for (const role of MODEL_ROLES) {
    const presetId = parsed.data[role];
    if (presetId === null) {
      if (role === "scout" || role === "plan_reviewer" || role === "reviewer") out[role] = null;
    } else {
      const id = presetId?.trim();
      if (id) out[role] = id;
    }
  }
  return out;
}

/**
 * The preset a job runs with: the card's pick, then the project default, then the global default.
 * `exists` skips an id whose preset was deleted. With a card given, a skippable job without a pick
 * resolves to nothing (the card said "do not"); without a card (a new card) the defaults apply.
 */
export function resolveModel(
  role: ModelRole,
  card: Partial<Record<CardModelField, string | null>> | null | undefined,
  project: { defaultPresets: ModelDefaults } | null | undefined,
  global: ModelDefaults | null | undefined,
  exists: (id: string) => boolean = () => true,
): ResolvedModel {
  const own = card?.[CARD_MODEL_FIELD[role]];
  if (own && exists(own)) return { presetId: own, source: "card" };
  if (card && SKIPPABLE_ROLES.includes(role)) return { presetId: null, source: null };
  const fromProject = project?.defaultPresets[role];
  if (fromProject && exists(fromProject)) return { presetId: fromProject, source: "project" };
  const fromGlobal = global?.[role];
  if (fromGlobal && exists(fromGlobal)) return { presetId: fromGlobal, source: "global" };
  return { presetId: null, source: null };
}

/** Card fields a new card gets from the defaults, for the jobs the caller left open (`undefined`). */
export function prefillModels(
  given: Partial<Record<CardModelField, string | null | undefined>>,
  project: { defaultPresets: ModelDefaults } | null | undefined,
  global: ModelDefaults | null | undefined,
  exists: (id: string) => boolean = () => true,
): Partial<Record<CardModelField, string>> {
  const out: Partial<Record<CardModelField, string>> = {};
  for (const role of MODEL_ROLES) {
    const field = CARD_MODEL_FIELD[role];
    if (given[field] !== undefined) continue;
    const { presetId } = resolveModel(role, null, project, global, exists);
    if (presetId) out[field] = presetId;
  }
  return out;
}

/** Missing key / inherit, a named preset, or disabled (only the three optional roles). */
export const TaskRoleSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z.object({ mode: z.literal("preset"), presetId: z.string().trim().min(1) }).strict(),
  z.object({ mode: z.literal("disabled") }).strict(),
]);
export type TaskRoleSelection = z.infer<typeof TaskRoleSelectionSchema>;
export const OPTIONAL_TASK_ROLES: readonly ModelRole[] = ["scout", "plan_reviewer", "reviewer"];
export const TaskRoleSelectionsSchema = z
  .object({
    scout: TaskRoleSelectionSchema.optional(),
    planner: TaskRoleSelectionSchema.optional(),
    plan_reviewer: TaskRoleSelectionSchema.optional(),
    worker: TaskRoleSelectionSchema.optional(),
    subagent: TaskRoleSelectionSchema.optional(),
    reviewer: TaskRoleSelectionSchema.optional(),
    verifier: TaskRoleSelectionSchema.optional(),
  })
  .strict()
  .superRefine((selections, ctx) => {
    for (const role of MODEL_ROLES) {
      if (selections[role]?.mode === "disabled" && !OPTIONAL_TASK_ROLES.includes(role))
        ctx.addIssue({ code: "custom", path: [role], message: role + " 不能不启用" });
    }
  });
export type TaskRoleSelections = z.infer<typeof TaskRoleSelectionsSchema>;

/** Immutable execution inputs; no live preset lookup is needed after confirmation. */
export const TaskPresetSnapshotSchema = z
  .object({
    presetId: z.string().min(1),
    source: z.enum(["task", "project", "global", "worker"]),
    models: z
      .array(
        z
          .object({
            provider: z.string().trim().min(1),
            model: z.string(),
            thinking: z.string(),
            permissionMode: PresetPermissionModeSchema,
          })
          .strict(),
      )
      .min(1),
    environmentKind: PresetEnvironmentKindSchema,
    runtimeEnv: z.string().nullable(),
    instructions: z.string(),
  })
  .strict();
export type TaskPresetSnapshot = z.infer<typeof TaskPresetSnapshotSchema>;

/** Actual overrides are frozen per confirmation round, member and optional planned subtask. */
export function findTaskActualPreset(
  task: { confirmedAt: string | null; control?: Record<string, unknown> | null },
  input: {
    agentId?: string;
    memberId?: string;
    role?: ModelRole;
    subtaskId?: string;
    admittedOnly?: boolean;
  },
): TaskPresetSnapshot | undefined {
  const entries = task.control?.actualModels;
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry: unknown = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const actual = entry as Record<string, unknown>;
    if (actual.confirmedAt !== task.confirmedAt) continue;
    if (input.admittedOnly && actual.admitted === false) continue;
    if (
      ["agentId", "memberId", "role", "subtaskId"].some((key) => {
        const selector = input[key as "agentId" | "memberId" | "role" | "subtaskId"];
        return selector !== undefined && actual[key] !== selector;
      })
    )
      continue;
    // Entries written before actual snapshot freezing only identify a model; never resolve them
    // through a now-mutable preset. Continue looking for a usable frozen entry instead.
    if (actual.presetSnapshot === undefined) continue;
    const parsed = TaskPresetSnapshotSchema.safeParse(actual.presetSnapshot);
    if (!parsed.success) throw new Error("实际接手模型的预设快照无效，请核对任务后再继续");
    return parsed.data;
  }
  return undefined;
}

export const TaskRoleSnapshotSchema = z
  .object({
    scout: TaskPresetSnapshotSchema.nullable(),
    planner: TaskPresetSnapshotSchema,
    plan_reviewer: TaskPresetSnapshotSchema.nullable(),
    worker: TaskPresetSnapshotSchema,
    subagent: TaskPresetSnapshotSchema,
    reviewer: TaskPresetSnapshotSchema.nullable(),
    verifier: TaskPresetSnapshotSchema,
    subtaskPresets: z.record(z.string(), TaskPresetSnapshotSchema).optional(),
  })
  .strict();
export type TaskRoleSnapshot = z.infer<typeof TaskRoleSnapshotSchema>;

/** Does not depend on cards. An explicit unavailable preset is an error, never a silent fallback. */
export function resolveTaskRoles(
  task: TaskRoleSelections,
  project: ModelDefaults | null | undefined,
  global: ModelDefaults | null | undefined,
  getPreset: (id: string) => Preset | undefined,
): TaskRoleSnapshot {
  const selections = TaskRoleSelectionsSchema.parse(task);
  const result: Partial<Record<ModelRole, TaskPresetSnapshot | null>> = {};
  // Resolve worker before subagent so its fallback is fully frozen too.
  for (const role of [
    "scout",
    "planner",
    "plan_reviewer",
    "worker",
    "subagent",
    "reviewer",
    "verifier",
  ] as const) {
    const own = selections[role];
    let id: string | null | undefined;
    let source: TaskPresetSnapshot["source"] = "task";
    if (own?.mode === "disabled") id = null;
    else if (own?.mode === "preset") id = own.presetId;
    else if (project?.[role] !== undefined) {
      id = project[role];
      source = "project";
    } else {
      id = global?.[role];
      source = "global";
    }
    if (!id) {
      if (role === "subagent") {
        result.subagent = { ...result.worker!, source: "worker" };
        continue;
      }
      if (!OPTIONAL_TASK_ROLES.includes(role))
        throw new Error("角色 " + role + " 未配置可用预设：请在任务、项目或全局默认中指定");
      result[role] = null;
      continue;
    }
    const preset = getPreset(id);
    if (!preset) throw new Error("角色 " + role + " 的预设不存在或不可用：" + id);
    result[role] = TaskPresetSnapshotSchema.parse({
      presetId: id,
      source,
      models: presetModels(preset),
      environmentKind: preset.environmentKind,
      runtimeEnv: preset.runtimeEnv,
      instructions: preset.instructions,
    });
  }
  return TaskRoleSnapshotSchema.parse(result);
}

/** Freeze explicit subtask presets alongside the seven role selections before confirmation. */
export function freezeTaskSubtaskPresets(
  plan: TaskPlan,
  roles: TaskRoleSnapshot,
  getPreset: (id: string) => Preset | undefined,
): TaskRoleSnapshot {
  const frozen = TaskRoleSnapshotSchema.parse(roles);
  const subtaskPresets: Record<string, TaskPresetSnapshot> = {};
  for (const subtask of plan.subtasks) {
    if (!subtask.presetId || subtask.presetId === frozen.subagent.presetId) continue;
    const preset = getPreset(subtask.presetId);
    if (!preset)
      throw new Error("子任务 " + subtask.id + " 的预设不存在或不可用：" + subtask.presetId);
    subtaskPresets[subtask.id] = TaskPresetSnapshotSchema.parse({
      presetId: subtask.presetId,
      source: "task",
      models: presetModels(preset),
      environmentKind: preset.environmentKind,
      runtimeEnv: preset.runtimeEnv,
      instructions: preset.instructions,
    });
  }
  return TaskRoleSnapshotSchema.parse({ ...frozen, subtaskPresets });
}

/** Admission validates frozen inputs only; deleted or edited live presets cannot alter a run. */
export function validateTaskSubtaskPresets(plan: TaskPlan, roles: TaskRoleSnapshot): void {
  const frozen = TaskRoleSnapshotSchema.parse(roles);
  for (const subtask of plan.subtasks) {
    if (!subtask.presetId) continue;
    const preset = frozen.subtaskPresets?.[subtask.id];
    if (preset && preset.presetId !== subtask.presetId)
      throw new Error("子任务 " + subtask.id + " 的预设快照与方案不匹配，请重新确认");
    if (!preset && subtask.presetId !== frozen.subagent.presetId)
      throw new Error("子任务 " + subtask.id + " 缺少自定预设快照，请重新确认");
  }
}
