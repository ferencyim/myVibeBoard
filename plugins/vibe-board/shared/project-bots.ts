import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotCreateSchema, BotMemorySchema, BotSchema } from "./vibe/contract/bots";

const BotViewSchema = BotSchema.extend({
  memories: z.array(BotMemorySchema),
  isDefault: z.boolean(),
});
export const projectBotsListRpc = defineRpc({
  name: "bots.list",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ bots: z.array(BotViewSchema) }),
});
export const projectBotsCreateRpc = defineRpc({
  name: "bots.create",
  input: BotCreateSchema,
  output: z.object({ bot: BotViewSchema }),
});
export const projectBotsOpenRpc = defineRpc({
  name: "bots.open",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ agentId: z.string(), workspaceId: z.string().nullable() }),
});
export const projectBotsArchiveRpc = defineRpc({
  name: "bots.archive",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});
export const botHandoffRpc = defineRpc({
  name: "vibe.bot.handoff",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ text: z.string() }),
});

export const projectBotModelRpc = defineRpc({
  name: "vibe.project.bot.model",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({
    config: z.object({
      provider: z.string(),
      thinkingOptionId: z.string().optional(),
      modeId: z.string().optional(),
      systemPrompt: z.string().optional(),
    }),
    runtimeEnv: z.string().optional(),
  }),
});
