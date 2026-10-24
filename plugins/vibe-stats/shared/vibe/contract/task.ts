// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Workspace task orchestration (WP-110). Native messages and project identity stay in Paseo.
import { z } from "zod";
import { TaskRoleSelectionsSchema, TaskRoleSnapshotSchema } from "./model-roles";
import type { PromptDef } from "./prompts";
import { subtaskListError } from "./subtasks";

const Text = z.string().trim().min(1);
export const TASK_PHASES = [
  "planning",
  "awaiting_confirmation",
  "queued",
  "executing",
  "reviewing",
  "verifying",
  "awaiting_acceptance",
  "completed",
  "paused",
  "failed",
] as const;
export const TaskPhaseSchema = z.enum(TASK_PHASES);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;
export const TASK_PHASE_LABELS: Record<TaskPhase, string> = {
  planning: "规划",
  awaiting_confirmation: "待确认",
  queued: "排队",
  executing: "执行",
  reviewing: "复核",
  verifying: "验证",
  awaiting_acceptance: "待验收",
  completed: "完成",
  paused: "暂停",
  failed: "失败",
};

export const TaskPlanSubtaskSchema = z
  .object({
    id: Text,
    goal: Text,
    method: Text,
    notes: z.string(),
    dependsOn: z.array(Text),
    files: z.array(Text),
    acceptance: Text,
    presetId: Text.nullable().optional(),
  })
  .strict();
export type TaskPlanSubtask = z.infer<typeof TaskPlanSubtaskSchema>;

/** All sections are mandatory, including empty files/subtasks arrays for work without changes. */
export const TaskPlanSchema = z
  .object({
    goal: Text,
    approach: Text,
    files: z.array(Text),
    subtasks: z.array(TaskPlanSubtaskSchema),
    checks: z.array(z.object({ text: Text, method: Text }).strict()).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const error = subtaskListError(plan.subtasks);
    if (error) ctx.addIssue({ code: "custom", path: ["subtasks"], message: error });
  });
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export const TASK_PLAN_FENCE = "vibe-plan";
/** Parse the complete latest model output, never a previous plan or an arbitrary JSON block. */
export function parseTaskPlan(output: string): TaskPlan {
  const openings = [...output.matchAll(/^```vibe-plan[^\r\n]*$/gm)];
  if (openings.length !== 1) throw new Error("方案必须包含且仅包含一个完整的 vibe-plan JSON 段");
  const match = /^```vibe-plan[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(
    output.slice(openings[0]!.index),
  );
  if (!match) throw new Error("vibe-plan 方案段不完整");
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    throw new Error("vibe-plan 方案段不是有效 JSON");
  }
  const parsed = TaskPlanSchema.safeParse(value);
  if (!parsed.success) throw new Error("方案格式不完整或无效：" + parsed.error.message);
  return parsed.data;
}

export const TASK_SUBTASK_STATES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "paused",
  "failed",
] as const;
export const TaskSubtaskRunSchema = z
  .object({
    subtaskId: Text,
    dependsOn: z.array(Text),
    state: z.enum(TASK_SUBTASK_STATES),
    agentId: Text.nullable(),
    actualModel: z
      .object({ provider: Text, model: Text, thinking: z.string().optional() })
      .strict()
      .nullable(),
    continuation: z
      .object({
        previousAgentId: Text.nullable(),
        summary: z.string(),
        candidateIndex: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    summary: z.string(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (["running", "waiting"].includes(run.state) && (!run.agentId || !run.actualModel)) {
      ctx.addIssue({ code: "custom", message: "运行中的子任务必须保存原生 agent 和实际模型" });
    }
  });
export type TaskSubtaskRun = z.infer<typeof TaskSubtaskRunSchema>;

/** A task tab is an ordinary Paseo agent; the number never changes and is never reused. */
export const TASK_TAB_ROLES = [
  "main",
  "scout",
  "plan_reviewer",
  "worker",
  "reviewer",
  "verifier",
  "session",
] as const;
export const TaskTabRoleSchema = z.enum(TASK_TAB_ROLES);
export type TaskTabRole = z.infer<typeof TaskTabRoleSchema>;
export const TASK_TAB_ROLE_LABELS: Record<TaskTabRole, string> = {
  main: "主会话",
  scout: "探路",
  plan_reviewer: "方案复核",
  worker: "执行",
  reviewer: "复核",
  verifier: "验证",
  session: "会话",
};
/** Native agent labels used to recognize plugin-opened task tabs. */
export const TASK_TAB_ROLE_LABEL = "vibe.tab.role";
export const TASK_TAB_PRESET_LABEL = "vibe.tab.preset";
export const TaskTabSchema = z
  .object({
    number: z.number().int().positive(),
    agentId: Text,
    role: TaskTabRoleSchema,
    provider: Text,
    model: Text,
    thinking: z.string().optional(),
    presetId: Text.optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type TaskTab = z.infer<typeof TaskTabSchema>;

/** Public timeline locator. Message contents remain in the host's durable history. */
export const TaskPlanSourceSchema = z
  .object({
    conversationId: Text.optional(),
    tabNumber: z.number().int().positive().optional(),
    agentId: Text.optional(),
    sourceKey: Text,
    memberId: Text.optional(),
    backendAgentId: Text.optional(),
    sourceTurnId: Text.optional(),
    epoch: z.string().optional(),
    seq: z.number().int().nonnegative().optional(),
    messageId: Text.optional(),
    sourceEpoch: z.string().optional(),
    sourceSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TaskPlanSource = z.infer<typeof TaskPlanSourceSchema>;
export const TaskControlSchema = z.record(z.string(), z.unknown());
export type TaskControl = z.infer<typeof TaskControlSchema>;
export const TaskActionSchema = z.enum([
  "plan",
  "review_plan",
  "execute",
  "review",
  "verify",
  "accept",
  "stop",
  "reject",
]);
export type TaskAction = z.infer<typeof TaskActionSchema>;
export const TaskActionInputSchema = z
  .object({
    workspaceId: Text,
    /** The agent tab that issued the command; only user slash commands may authorize. */
    agentId: Text.optional(),
    conversationId: Text.optional(),
    requestId: Text,
    action: TaskActionSchema,
    source: TaskPlanSourceSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type TaskActionInput = z.infer<typeof TaskActionInputSchema>;

export const TASK_ARTIFACT_KINDS = [
  "plan",
  "scout",
  "plan_review",
  "delivery",
  "review",
  "verification",
  "git",
] as const;
export const TaskArtifactKindSchema = z.enum(TASK_ARTIFACT_KINDS);
export type TaskArtifactKind = z.infer<typeof TaskArtifactKindSchema>;
export const TaskArtifactSchema = z.object({
  workspaceId: Text,
  kind: TaskArtifactKindSchema,
  sourceKey: Text,
  confirmedAt: z.iso.datetime().nullable(),
  source: TaskPlanSourceSchema,
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
  published: z
    .object({ epoch: z.string(), seq: z.number().int().nonnegative() })
    .strict()
    .nullable(),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;
export const TaskSchema = z.object({
  workspaceId: Text,
  anchorAgentId: Text,
  phase: TaskPhaseSchema,
  plan: TaskPlanSchema.nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  rolesSnapshot: TaskRoleSnapshotSchema.nullable(),
  subtaskRuns: z.array(TaskSubtaskRunSchema),
  summary: z.string(),
  conversationId: Text.nullable().optional(),
  tabs: z.array(TaskTabSchema),
  nextTabNumber: z.number().int().min(1),
  planSource: TaskPlanSourceSchema.nullable().optional(),
  roleSelections: TaskRoleSelectionsSchema.nullable().optional(),
  control: TaskControlSchema.nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** The reply format is a registered read-only suffix; ordinary planning guidance stays editable. */
export const TASK_PLAN_PROMPT: PromptDef = {
  key: "task.plan_format",
  plugin: "vibe-shared",
  role: "planner",
  title: "任务方案固定格式",
  description: "任务确认前必须校验的完整方案段。",
  whenSent: "当前规划成员输出可执行方案时",
  audience: "规划 agent",
  defaultText: "",
  fixedSuffix:
    "请使用中文说明方案，并在最新完整回复中仅输出一个标记为 vibe-plan 的 JSON 代码块。JSON 必须包含 goal（目标）、approach（做法）、files（文件或 glob 数组）、subtasks（子任务数组）和 checks（至少一项，每项含 text 与 method）。每个子任务必须包含 id、goal、method、notes（注意事项，可为空）、dependsOn（依赖编号数组）、files 和 acceptance（验收），可选 presetId（预设编号或 null）。无涉及文件或无子任务时仍须输出空数组。依赖必须存在且不能成环。不要省略字段，不要输出多个方案段；普通说明仍用中文 Markdown。",
};
