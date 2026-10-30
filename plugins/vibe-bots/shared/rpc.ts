import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotThreadSchema } from "./vibe/contract/bot-thread";
import {
  BotSchema,
  BotCreateSchema,
  BotPatchSchema,
  BotMemorySchema,
} from "./vibe/contract/bots";

export const BotViewSchema = BotSchema.extend({
  memories: z.array(BotMemorySchema),
  isDefault: z.boolean(),
});
export const botsListRpc = defineRpc({
  name: "bots.list",
  input: z.object({
    kind: z.enum(["independent", "project"]).optional(),
    projectId: z.string().optional(),
    includeArchived: z.boolean().optional(),
  }),
  output: z.object({ bots: z.array(BotViewSchema) }),
});
export const botsCreateRpc = defineRpc({
  name: "bots.create",
  input: BotCreateSchema,
  output: z.object({ bot: BotViewSchema }),
});
export const botsUpdateRpc = defineRpc({
  name: "bots.update",
  input: z.object({ id: z.string(), patch: BotPatchSchema }),
  output: z.object({ bot: BotViewSchema }),
});
export const botsArchiveRpc = defineRpc({
  name: "bots.archive",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});
export const BotOpenStateSchema = z.object({
  status: z.enum(["idle", "creating", "ready", "failed"]),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  error: z.string().nullable(),
});
const threadIdentity = { botId: z.string().min(1), id: z.string().min(1) };
const threadTitle = z.string().trim().min(1).max(200);
export const threadsListRpc = defineRpc({ name: "threads.list", input: z.object({ botId: z.string().min(1) }), output: z.object({ threads: z.array(BotThreadSchema) }) });
export const threadsCreateRpc = defineRpc({ name: "threads.create", input: z.object({ botId: z.string().min(1), title: threadTitle }), output: z.object({ thread: BotThreadSchema }) });
export const threadsRenameRpc = defineRpc({ name: "threads.rename", input: z.object({ ...threadIdentity, title: threadTitle }), output: z.object({ thread: BotThreadSchema }) });
export const threadsArchiveRpc = defineRpc({ name: "threads.archive", input: z.object(threadIdentity), output: z.object({ ok: z.literal(true) }) });
export const threadsOpenRpc = defineRpc({ name: "threads.open", input: z.object(threadIdentity), output: BotOpenStateSchema });
export const botsOpenRpc = defineRpc({
  name: "bots.open",
  input: z.object({ id: z.string() }),
  output: BotOpenStateSchema,
});
export const botsStateRpc = defineRpc({
  name: "bots.state",
  input: z.object({ id: z.string() }),
  output: BotOpenStateSchema,
});
export const projectDefaultBotGetRpc = defineRpc({
  name: "project.default_bot.get",
  input: z.object({ projectId: z.string() }),
  output: z.object({ botId: z.string().nullable(), mainAgentId: z.string().nullable() }),
});
export const projectDefaultBotSetRpc = defineRpc({
  name: "project.default_bot.set",
  input: z.object({ projectId: z.string(), botId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});
export const memoriesListRpc = defineRpc({
  name: "memories.list",
  input: z.object({ botId: z.string() }),
  output: z.object({ memories: z.array(BotMemorySchema) }),
});
export const memoriesAddRpc = defineRpc({
  name: "memories.add",
  input: z.object({
    botId: z.string(),
    text: z.string().trim().min(1).max(30_000),
    pinned: z.boolean().optional(),
  }),
  output: z.object({ memory: BotMemorySchema }),
});
export const memoriesUpdateRpc = defineRpc({
  name: "memories.update",
  input: z.object({
    botId: z.string(),
    id: z.string(),
    text: z.string().trim().min(1).max(30_000).optional(),
    pinned: z.boolean().optional(),
  }),
  output: z.object({ memory: BotMemorySchema }),
});
export const memoriesRemoveRpc = defineRpc({
  name: "memories.remove",
  input: z.object({ botId: z.string(), id: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});
export const modelsListRpc = defineRpc({
  name: "models.list",
  input: z.object({ query: z.string().optional(), projectId: z.string().optional(), refresh: z.boolean().optional() }),
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
export const botsCoordinatorTransferRpc = defineRpc({
  name: "bots.coordinator.transfer",
  input: z.object({ toBotId: z.string().min(1) }),
  output: z.object({ bots: z.array(BotViewSchema) }),
});
/** For other plugins (resource hub, task board): queue a system message for a bot's main conversation. */
export const botsNotifyRpc = defineRpc({
  name: "bots.notify",
  input: z.object({
    target: z.union([z.literal("coordinator"), z.object({ projectId: z.string().min(1) }).strict()]),
    text: z.string().trim().min(1).max(8000),
    /** Short sender label such as "中枢" or "任务看板". */
    source: z.string().trim().min(1).max(40).default("系统"),
  }),
  output: z.object({ accepted: z.boolean(), reason: z.string().optional() }),
});
