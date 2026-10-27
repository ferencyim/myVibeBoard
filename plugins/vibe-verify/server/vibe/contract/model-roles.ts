// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Seven task roles. Task choices override project defaults, then global defaults.

import { z } from "zod";
import { PresetEnvironmentKindSchema, PresetPermissionModeSchema, type RoleHint } from "./enums";
import type { Preset } from "./model";
import { presetModels } from "./preset-models";
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

/** Missing key inherits; a preset ID selects; null disables an optional role. Round 8: the #2 方案
 *  tab runs an ordered model list (`planners`): the first writes the plan, the rest review it. */
export const ModelDefaultsSchema = z.object({
  scout: z.string().nullable().optional(),
  planners: z.array(z.string()).optional(),
  // COMPAT(planner-list): single planner + plan reviewer before round 8. Core migration 19 and
  // cleanDefaults turn them into `planners`; remove after 2027-04-26.
  planner: z.string().optional(),
  plan_reviewer: z.string().nullable().optional(),
  worker: z.string().optional(),
  subagent: z.string().optional(),
  reviewer: z.string().nullable().optional(),
  verifier: z.string().optional(),
});
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

/** The #2 方案 model list of one defaults level, or undefined when the level does not set it.
 *  Legacy rows: planner, then plan_reviewer when it names a preset. A legacy level that only set
 *  plan_reviewer cannot be expressed as a list and inherits. */
export function plannerList(defaults: ModelDefaults | null | undefined): string[] | undefined {
  if (!defaults) return undefined;
  if (defaults.planners !== undefined) {
    const ids = defaults.planners.map((id) => id.trim()).filter(Boolean);
    return ids.length ? ids : undefined;
  }
  const planner = defaults.planner?.trim();
  if (!planner) return undefined;
  const reviewer = defaults.plan_reviewer?.trim();
  return reviewer ? [planner, reviewer] : [planner];
}

/** The preset a defaults level names for one role. The two planning roles read the list:
 *  planner is its first entry; plan_reviewer is the second, or disabled for a one-model list. */
export function defaultPresetId(
  defaults: ModelDefaults | null | undefined,
  role: ModelRole,
): string | null | undefined {
  if (role === "planner") return plannerList(defaults)?.[0];
  if (role === "plan_reviewer") {
    const list = plannerList(defaults);
    return list ? (list[1] ?? null) : undefined;
  }
  return defaults?.[role];
}

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

/** Keep known preset IDs and explicit optional-role disables from settings or JSON columns. The
 *  planning roles are always written as the `planners` list. */
export function cleanDefaults(value: unknown): ModelDefaults {
  const parsed = ModelDefaultsSchema.safeParse(value);
  if (!parsed.success) return {};
  const out: ModelDefaults = {};
  for (const role of MODEL_ROLES) {
    if (role === "planner" || role === "plan_reviewer") continue;
    const presetId = parsed.data[role];
    if (presetId === null) {
      if (role === "scout" || role === "reviewer") out[role] = null;
    } else {
      const id = presetId?.trim();
      if (id) out[role] = id;
    }
  }
  const planners = plannerList(parsed.data);
  if (planners) out.planners = planners;
  return out;
}

/** Every preset id a defaults level names (validation and preset deletion). */
export function defaultsPresetIds(defaults: ModelDefaults): string[] {
  const ids = new Set<string>(plannerList(defaults) ?? []);
  for (const role of MODEL_ROLES) {
    if (role === "planner" || role === "plan_reviewer") continue;
    const id = defaults[role]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The #2 方案 list for a task: the task may pin the writer (planner) or turn review off
 *  (plan_reviewer disabled) or pin one reviewer; otherwise the project list wins over the global
 *  list as a whole. The result has at least the writer, or is empty when nothing is configured. */
export function resolvePlannerIds(
  task: TaskRoleSelections | null | undefined,
  project: ModelDefaults | null | undefined,
  global: ModelDefaults | null | undefined,
): { ids: string[]; source: TaskPresetSnapshot["source"] } {
  const level = plannerList(project) ? "project" : "global";
  const list = (level === "project" ? plannerList(project) : plannerList(global)) ?? [];
  const own = task?.planner;
  const writer = own?.mode === "preset" ? own.presetId : list[0];
  if (!writer) return { ids: [], source: level };
  const review = task?.plan_reviewer;
  const reviewers =
    review?.mode === "disabled" ? [] : review?.mode === "preset" ? [review.presetId] : list.slice(1);
  return { ids: [writer, ...reviewers], source: own?.mode === "preset" ? "task" : level };
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
    else if (defaultPresetId(project, role) !== undefined) {
      id = defaultPresetId(project, role);
      source = "project";
    } else {
      id = defaultPresetId(global, role);
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
