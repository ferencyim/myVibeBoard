import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TaskSchema, TaskTabRoleSchema } from "./vibe/contract";

/** Only the user's native composer may invoke these commands; agent tool calls are rejected. */
export const TaskTabCommandSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.enum(["execute", "accept", "stop", "handoff", "status", "rereview"]),
  requestId: z.string().min(1),
  reason: z.string().optional(),
});
export type TaskTabCommand = z.infer<typeof TaskTabCommandSchema>;

export const taskTabCommandRpc = defineRpc({
  name: "vibe.task.tabs.command",
  input: TaskTabCommandSchema,
  output: z.object({ task: TaskSchema, message: z.string() }),
});

/** Task status rows appended by the plugin; rendered by this plugin's timeline renderer. */
export const taskStatusDataSchema = z.object({ text: z.string() });

export const TaskTabViewSchema = z.object({
  number: z.number().int().positive(),
  agentId: z.string(),
  role: TaskTabRoleSchema,
  roleLabel: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  busy: z.boolean(),
  thinking: z.string().optional(),
  modelId: z.string().optional(),
  source: z.string().optional(),
});
export type TaskTabViewData = z.infer<typeof TaskTabViewSchema>;

/** Placeholder discovery only: no plan scan, agent refresh or provisioning. */
export const taskWorkspaceTabsRpc = defineRpc({
  name: "vibe.task.tabs.resolve",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.array(TaskTabViewSchema),
});

export const TaskStepSchema = z.object({
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type TaskStepData = z.infer<typeof TaskStepSchema>;

/** One in-task board subtask as the flow panel shows it (WP-127). */
export const TaskBoardItemSchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.enum(["todo", "in_progress", "done", "blocked"]),
  statusLabel: z.string(),
  files: z.array(z.string()),
  readOnly: z.boolean().optional(),
  dependsOn: z.array(z.string()),
  claimedBy: z.string().nullable(),
  claimedTab: z.number().nullable(),
  summary: z.string(),
  outOfScope: z.array(z.string()),
});
export type TaskBoardItemData = z.infer<typeof TaskBoardItemSchema>;

/** Another task of the same project and its derived plan status (WP-130). */
export const ProjectPlanSchema = z.object({
  workspaceId: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  goal: z.string().nullable(),
  files: z.array(z.string()),
  updatedAt: z.string().nullable(),
  overlap: z.tuple([z.string(), z.string()]).nullable(),
  /** Absolute paths outside that task's worktree (scope unknown, not overlap-checked). */
  unknownFiles: z.array(z.string()).optional(),
});
export type ProjectPlanData = z.infer<typeof ProjectPlanSchema>;

/** Read-only data for the lightweight flow panel; no command is authorized here. */
export const taskPanelRpc = defineRpc({
  name: "vibe.task.panel",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    isTask: z.boolean(),
    task: TaskSchema.nullable(),
    phaseLabel: z.string(),
    blockingReason: z.string().nullable(),
    tabs: z.array(TaskTabViewSchema),
    steps: z.array(TaskStepSchema),
    board: z.array(TaskBoardItemSchema).optional(),
    otherPlans: z.array(ProjectPlanSchema).optional(),
  }),
});

/** #1「发给」选择器：主会话 composer 的发送目标。`number` 为 null 表示群主（#1 自己）。 */
export const GroupTargetsSchema = z.object({
  /** True only for a task's #1 (main) tab; the picker shows nowhere else. */
  main: z.boolean(),
  selfNumber: z.number().int().positive().nullable(),
  selected: z.number().int().positive().nullable(),
  options: z.array(
    z.object({
      number: z.number().int().positive(),
      label: z.string(),
      /** The tab's role; `worker` means a message there authorizes execution. */
      role: z.string(),
      open: z.boolean(),
    }),
  ),
});
export type GroupTargets = z.infer<typeof GroupTargetsSchema>;

export const groupTargetsRpc = defineRpc({
  name: "vibe.task.group.targets",
  input: z.object({ workspaceId: z.string().min(1), agentId: z.string().min(1) }),
  output: GroupTargetsSchema,
});

export const groupSelectRpc = defineRpc({
  name: "vibe.task.group.select",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    number: z.number().int().positive().nullable(),
  }),
  output: GroupTargetsSchema,
});

export const taskTabEnsureRpc = defineRpc({
  name: "vibe.task.tabs.ensure",
  input: z.object({
    workspaceId: z.string().min(1),
    role: z.enum(["planner", "scout", "worker", "reviewer", "verifier"]),
    enable: z.boolean().optional(),
    provider: z.string().regex(/^[^/]+\/.+$/, "请选择完整的 provider/model 模型").optional(),
    thinkingOptionId: z.string().optional(),
  }),
  output: z.object({ agentId: z.string().min(1) }),
});
