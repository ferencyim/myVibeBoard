import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotCreateSchema, BotMemorySchema, BotSchema } from "./vibe/contract/bots";
import { ProjectAgentStateSchema } from "./project-agent";

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
  output: ProjectAgentStateSchema,
});
export const projectBotsStateRpc = defineRpc({
  name: "bots.state",
  input: z.object({ id: z.string().min(1) }),
  output: ProjectAgentStateSchema,
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

export const botModelsListRpc = defineRpc({
  name: "models.list",
  input: z.object({ query: z.string().optional(), projectId: z.string().optional() }),
  output: z.object({
    defaultPresetId: z.string().nullable().optional(),
    providers: z.array(z.object({
      provider: z.string(),
      defaultModel: z.string().nullable(),
      models: z.array(z.object({
        id: z.string(),
        name: z.string(),
        isDefault: z.boolean(),
        thinkingOptions: z.array(z.object({ id: z.string(), name: z.string() })),
      })),
    })),
    presets: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});
