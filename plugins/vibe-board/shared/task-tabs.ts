import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TaskSchema, TaskTabRoleSchema } from "./vibe/contract";

/** Only the user's native composer may invoke these commands; agent tool calls are rejected. */
export const TaskTabCommandSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.enum(["execute", "accept", "stop", "handoff", "status"]),
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
  agentId: z.string().min(1),
  role: TaskTabRoleSchema,
  roleLabel: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  busy: z.boolean(),
});
export type TaskTabViewData = z.infer<typeof TaskTabViewSchema>;

export const TaskStepSchema = z.object({
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type TaskStepData = z.infer<typeof TaskStepSchema>;

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
  }),
});
