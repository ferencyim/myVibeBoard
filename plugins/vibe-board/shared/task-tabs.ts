import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TaskSchema } from "./vibe/contract";

/** Only the user's native composer may invoke these commands; agent tool calls are rejected. */
export const TaskTabCommandSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.enum(["execute", "accept", "status"]),
  requestId: z.string().min(1),
  reason: z.string().optional(),
});
export type TaskTabCommand = z.infer<typeof TaskTabCommandSchema>;

export const taskTabCommandRpc = defineRpc({
  name: "vibe.task.tabs.command",
  input: TaskTabCommandSchema,
  output: z.object({ task: TaskSchema, message: z.string() }),
});

export const taskTabStatusRpc = defineRpc({
  name: "vibe.task.tabs.status",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
  }),
  output: z.object({ task: TaskSchema, text: z.string() }),
});
