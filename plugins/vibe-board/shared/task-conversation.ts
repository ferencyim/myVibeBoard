import { defineRpc } from "@getpaseo/plugin";
import type { TaskConversationRecipient } from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  ModelRoleSchema,
  TaskActionInputSchema,
  TaskArtifactSchema,
  TaskPlanSourceSchema,
  TaskRoleSelectionSchema,
  TaskSchema,
} from "./vibe/contract";

// Recipients come from the server SDK; the host validates the full native contract on selection/send.
// Keep the native schema out of the plugin bundle, which can use a separately installed SDK version.
const Recipient = z.custom<TaskConversationRecipient>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    "role" in value &&
    typeof value.role === "string" &&
    "config" in value &&
    value.config !== null &&
    typeof value.config === "object",
);

export const TaskConversationPanelSchema = z.object({
  task: TaskSchema.nullable(),
  conversationStatus: z.enum(["active", "stopping", "paused", "archived"]).optional(),
  latestPlanSource: TaskPlanSourceSchema.nullable().optional(),
  blockers: z.array(z.string()),
  subtasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      dependsOn: z.array(z.string()),
      status: z.string(),
      role: ModelRoleSchema,
      model: z.string().nullable(),
      memberId: z.string().optional(),
      backendAgentId: z.string().optional(),
      summary: z.string(),
    }),
  ),
  artifacts: z.array(TaskArtifactSchema),
  recipients: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      role: ModelRoleSchema,
      presetId: z.string().optional(),
      recipient: Recipient,
    }),
  ),
  suggestedRecipientId: z.string().optional(),
  members: z.array(
    z.object({
      memberId: z.string(),
      backendAgentId: z.string(),
      role: z.string(),
      provider: z.string(),
      model: z.string().nullable(),
      presetId: z.string().optional(),
      lastRequestAt: z.string().nullable(),
      status: z.string(),
    }),
  ),
  cache: z.object({
    ttlSecondsByProvider: z.record(z.string(), z.number().nonnegative()),
    fallbackTtlSeconds: z.number().nonnegative(),
    autoCompact: z.boolean(),
  }),
});
export type TaskConversationPanelSnapshot = z.infer<typeof TaskConversationPanelSchema>;

export const taskConversationPanelRpc = defineRpc({
  name: "vibe.task.conversation.panel",
  input: z.object({ workspaceId: z.string().min(1), conversationId: z.string().min(1) }),
  output: TaskConversationPanelSchema,
});

export const taskConversationCommandRpc = defineRpc({
  name: "vibe.task.conversation.command",
  input: TaskActionInputSchema,
  output: z.object({ task: TaskSchema, message: z.string() }),
});

export const taskConversationSelectRoleRpc = defineRpc({
  name: "vibe.task.conversation.select_role",
  input: z.object({
    workspaceId: z.string().min(1),
    conversationId: z.string().min(1),
    role: ModelRoleSchema,
    selection: TaskRoleSelectionSchema,
  }),
  output: TaskSchema,
});
