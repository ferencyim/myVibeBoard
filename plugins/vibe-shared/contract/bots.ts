import { z } from "zod";

export const BotModelSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  thinking: z.string().default(""),
});
export const BotPermissionSchema = z.enum(["accept-edits", "auto", "full"]);
export const BotFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  title: z.string().max(200).default(""),
  avatarSeed: z.string().max(200).default(""),
  avatarHue: z.number().int().min(0).max(359).default(210),
  avatarPath: z.string().nullable().default(null),
  instructions: z.string().max(30_000).default(""),
  presetId: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  thinking: z.string().default(""),
  backupModels: z.array(BotModelSchema).max(20).default([]),
  notifications: z.object({
    enabled: z.boolean().default(true),
    completed: z.boolean().default(true),
    failed: z.boolean().default(true),
  }).default({ enabled: true, completed: true, failed: true }),
  permissionMode: BotPermissionSchema.default("auto"),
  /** Fast mode of the main conversation (Claude fast_mode, Codex service_tier=fast). */
  fastMode: z.boolean().default(false),
});
export const BotCreateSchema = BotFieldsSchema.extend({
  kind: z.enum(["independent", "project"]),
  projectId: z.string().nullable().default(null),
}).superRefine((value, ctx) => {
  if ((value.kind === "project") !== !!value.projectId) {
    ctx.addIssue({
      code: "custom",
      message: "项目 bot 必须指定项目，bot 不能指定项目",
      path: ["projectId"],
    });
  }
});
// Zod 4 applies inner defaults even under optional(); updates must omit absent fields.
export const BotPatchSchema = z.object({
  name: BotFieldsSchema.shape.name.optional(),
  title: BotFieldsSchema.shape.title.removeDefault().optional(),
  avatarSeed: BotFieldsSchema.shape.avatarSeed.removeDefault().optional(),
  avatarHue: BotFieldsSchema.shape.avatarHue.removeDefault().optional(),
  avatarPath: BotFieldsSchema.shape.avatarPath.removeDefault().optional(),
  instructions: BotFieldsSchema.shape.instructions.removeDefault().optional(),
  presetId: BotFieldsSchema.shape.presetId.removeDefault().optional(),
  provider: BotFieldsSchema.shape.provider.removeDefault().optional(),
  model: BotFieldsSchema.shape.model.removeDefault().optional(),
  thinking: BotFieldsSchema.shape.thinking.removeDefault().optional(),
  backupModels: BotFieldsSchema.shape.backupModels.removeDefault().optional(),
  notifications: BotFieldsSchema.shape.notifications.removeDefault().optional(),
  permissionMode: BotFieldsSchema.shape.permissionMode.removeDefault().optional(),
  fastMode: BotFieldsSchema.shape.fastMode.removeDefault().optional(),
}).strict();
export const BotSchema = BotFieldsSchema.extend({
  id: z.string().startsWith("bot_"),
  kind: z.enum(["independent", "project"]),
  projectId: z.string().nullable(),
  mainAgentId: z.string().nullable(),
  /** "coordinator" is globally unique (resource hub coordinator); null for every other bot. */
  role: z.literal("coordinator").nullable().default(null),
  pendingModel: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export const BotMemorySchema = z.object({
  id: z.string(),
  botId: z.string(),
  text: z.string().trim().min(1).max(30_000),
  pinned: z.boolean(),
  source: z.enum(["bot", "user"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Bot = z.infer<typeof BotSchema>;
export type BotMemory = z.infer<typeof BotMemorySchema>;
export type BotCreate = z.input<typeof BotCreateSchema>;
export type BotPatch = z.infer<typeof BotPatchSchema>;
