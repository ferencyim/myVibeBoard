import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import * as rpc from "./shared/rpc";
import { BotCreateSchema, BotPatchSchema } from "./server/vibe/contract/bots";
import { migrateOwner } from "./server/vibe/db/migrate";
import { openVibeDb } from "./server/vibe/db/sqlite";
import { createBotService } from "./server/service";
import { registerBotContinuations } from "./server/continuation";

function userOnly(callerAgentId: string | null | undefined) {
  if (callerAgentId) throw new Error("此操作仅供用户使用，请使用 bot 自配置工具");
}

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "vibe-bots");
  const service = createBotService(db, server.paseo);
  const stopContinuations = registerBotContinuations(db, service);
  server.handle(rpc.botsListRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    return { bots: service.bots.list(input).map(service.view) };
  });
  server.handle(rpc.botsCreateRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    return { bot: await service.create(input) };
  });
  server.handle(rpc.botsUpdateRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    return { bot: await service.update(input.id, input.patch) };
  });
  server.handle(rpc.botsArchiveRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    service.bots.archive(input.id);
    return { ok: true as const };
  });
  server.handle(rpc.botsOpenRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    return service.open(input.id);
  });
  server.handle(rpc.projectDefaultBotGetRpc, (input, ctx) => {
    userOnly(ctx.callerAgentId);
    return service.defaultBot(input.projectId);
  });
  server.handle(rpc.projectDefaultBotSetRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    service.bots.defaultSet(input.projectId, input.botId);
    return { ok: true as const };
  });
  server.handle(rpc.modelsListRpc, (input) => service.models(input.query));
  server.handle(rpc.memoriesListRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    return { memories: service.bots.memories(input.botId) };
  });
  server.handle(rpc.memoriesAddRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    return { memory: service.bots.memoryAdd(input.botId, input.text, input.pinned) };
  });
  server.handle(rpc.memoriesUpdateRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    const patch = {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    };
    return { memory: service.bots.memoryUpdate(input.botId, input.id, patch) };
  });
  server.handle(rpc.memoriesRemoveRpc, async (input, ctx) => {
    userOnly(ctx.callerAgentId);
    await service.ready();
    service.bots.memoryRemove(input.botId, input.id);
    return { ok: true as const };
  });

  const read = z.object({ id: z.string().optional() }).strict();
  server.registerAgentTool({
    name: "vibe_bot_read",
    description: "读取自己或同主机 bot 的公开资料，不含密钥与其它 bot 的个人记忆。",
    input: read,
    handler: async (input, ctx) => {
      const caller = await service.caller(ctx.callerAgentId);
      const target = service.bots.require(read.parse(input).id ?? caller.id);
      const { memories: _private, ...profile } = service.view(target);
      return profile;
    },
  });
  server.registerAgentTool({
    name: "vibe_bot_update",
    description: "修改自己的名字、头衔、说明、头像、模型、备用模型与通知。只能收紧权限；忙时模型变更待空闲生效。",
    input: BotPatchSchema,
    handler: async (input, ctx) => {
      const caller = await service.caller(ctx.callerAgentId);
      return service.update(caller.id, BotPatchSchema.parse(input), caller);
    },
  });
  const modelQuery = z.object({ query: z.string().optional() }).strict();
  server.registerAgentTool({
    name: "vibe_models_list",
    description: "查询各 provider 的可用模型、默认模型与思考强度，支持关键词筛选。",
    input: modelQuery,
    handler: async (input, ctx) => {
      await service.caller(ctx.callerAgentId);
      return service.models(modelQuery.parse(input).query);
    },
  });
  server.registerAgentTool({
    name: "vibe_bot_create",
    description: "创建 bot：独立 bot 可创建独立 bot 或项目 bot；项目 bot 只能创建本项目 bot。",
    input: BotCreateSchema,
    handler: async (input, ctx) => {
      const caller = await service.caller(ctx.callerAgentId);
      return service.create(BotCreateSchema.parse(input), caller);
    },
  });
  const memoryAdd = z.object({
    text: z.string().trim().min(1).max(30_000),
    pinned: z.boolean().optional(),
  }).strict();
  const memoryUpdate = memoryAdd.partial().extend({ id: z.string().min(1) }).strict();
  const memoryRemove = z.object({ id: z.string().min(1) }).strict();
  server.registerAgentTool({
    name: "vibe_memory_add",
    description: "保存自己的偏好与经验；项目事实仍写 AGENTS.md/CLAUDE.md。",
    input: memoryAdd,
    handler: async (input, ctx) => {
      const bot = await service.caller(ctx.callerAgentId);
      const value = memoryAdd.parse(input);
      return service.bots.memoryAdd(bot.id, value.text, value.pinned, "bot");
    },
  });
  server.registerAgentTool({
    name: "vibe_memory_update",
    description: "编辑或置顶自己的长期记忆。",
    input: memoryUpdate,
    handler: async (input, ctx) => {
      const bot = await service.caller(ctx.callerAgentId);
      const { id, ...patch } = memoryUpdate.parse(input);
      return service.bots.memoryUpdate(bot.id, id, patch);
    },
  });
  server.registerAgentTool({
    name: "vibe_memory_remove",
    description: "删除自己的长期记忆。",
    input: memoryRemove,
    handler: async (input, ctx) => {
      const bot = await service.caller(ctx.callerAgentId);
      service.bots.memoryRemove(bot.id, memoryRemove.parse(input).id);
      return { ok: true as const };
    },
  });
  server.registerAgentTool({
    name: "vibe_memory_list",
    description: "读取自己的长期记忆，置顶优先。",
    handler: async (_input, ctx) => {
      const bot = await service.caller(ctx.callerAgentId);
      return { memories: service.bots.memories(bot.id) };
    },
  });

  const stop = [
    server.before("agent.notification", async ({ request }) => {
      await service.ready();
      const bot = service.bots.list().find((item) => item.mainAgentId === request.agentId);
      if (!bot) return;
      const disabled = !bot.notifications.enabled;
      const completedDisabled = request.reason === "finished" && !bot.notifications.completed;
      const failedDisabled = request.reason === "error" && !bot.notifications.failed;
      if (disabled || completedDisabled || failedDisabled) return { ...request, suppressed: true };
    }),
    server.before("agent.turn_context", async ({ request }) => {
      await service.ready();
      const bot = service.bots.list().find((item) => item.mainAgentId === request.agentId);
      if (!bot) return;
      const delivery = service.memoryDelivery.prepare(bot.id, request.agentId, service.bots.memories(bot.id), [service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"));
      if (delivery) return { ...request, ...delivery };
    }),
    server.on("agent.turn_context_delivered", ({ agentId, deliveryId }) => {
      service.memoryDelivery.delivered(agentId, deliveryId);
    }),
    server.on("agent.turn_started", ({ agent }) => {
      service.live.add(agent.id);
    }),
    server.on("agent.turn_ended", async ({ agent, outcome }) => {
      service.live.delete(agent.id);
      const bot = service.bots.list().find((item) => item.mainAgentId === agent.id);
      if (!bot) return;
      const failed = outcome.kind === "failed";
      const completedNotice = outcome.kind === "completed" && bot.notifications.completed;
      const failedNotice = failed && bot.notifications.failed;
      if (bot.notifications.enabled && (failedNotice || completedNotice)) {
        server.notify({
          title: bot.name,
          body: failed ? "bot 运行失败，请打开主对话查看。" : "bot 已回复。",
          data: { agentId: agent.id, botId: bot.id },
          agentAttention: { agentId: agent.id, reason: failed ? "error" : "finished" },
        });
      }
      if (failed && await service.failover(bot.id, new Error(outcome.error.message))) return;
      await service.apply(bot.id);
    }),
  ];
  return async () => {
    for (const cleanup of stop) cleanup();
    await stopContinuations();
    await service.close();
    db.close();
  };
}
