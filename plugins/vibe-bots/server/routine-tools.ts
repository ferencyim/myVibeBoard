import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { RoutineCreateSchema, RoutinePatchSchema } from "./vibe/contract/routines";
import type { createRoutineStore } from "./vibe/db/routines";
import type { BotService } from "./service";

/** Agent tools never accept a bot identity from the model. */
export function registerRoutineTools(
  server: PluginServerContext,
  service: BotService,
  routines: ReturnType<typeof createRoutineStore>,
) {
  const create = RoutineCreateSchema.omit({ botId: true });
  const update = z.object({ id: z.string().min(1), patch: RoutinePatchSchema }).strict();
  const byId = z.object({ id: z.string().min(1) }).strict();

  async function owned(id: string, agentId: string | null) {
    const bot = await service.caller(agentId);
    const routine = routines.get(id);
    if (!routine || routine.botId !== bot.id) throw new Error("例程不存在或不属于当前 bot");
    return routine;
  }

  server.registerAgentTool({
    name: "vibe_routine_create",
    description: "为自己创建定时例程。",
    input: create,
    handler: async (input, ctx) => {
      const bot = await service.caller(ctx.callerAgentId);
      return routines.create({ ...create.parse(input), botId: bot.id });
    },
  });
  server.registerAgentTool({
    name: "vibe_routine_list",
    description: "查看自己的定时例程。",
    input: z.object({}).strict(),
    handler: async (input, ctx) => {
      z.object({}).strict().parse(input);
      const bot = await service.caller(ctx.callerAgentId);
      return { routines: routines.list(bot.id) };
    },
  });
  server.registerAgentTool({
    name: "vibe_routine_update",
    description: "修改自己的定时例程。",
    input: update,
    handler: async (input, ctx) => {
      const { id, patch } = update.parse(input);
      await owned(id, ctx.callerAgentId);
      return routines.update(id, patch);
    },
  });
  for (const operation of ["pause", "resume", "delete", "run_now"] as const) {
    server.registerAgentTool({
      name: `vibe_routine_${operation}`,
      description: ({ pause: "暂停", resume: "恢复", delete: "删除", run_now: "立即运行" })[operation] + "自己的定时例程。",
      input: byId,
      handler: async (input, ctx) => {
        const { id } = byId.parse(input);
        await owned(id, ctx.callerAgentId);
        if (operation === "run_now") await routines.runNow(id);
        else if (operation === "delete") await routines.delete(id);
        else if (operation === "pause") await routines.pause(id);
        else await routines.resume(id);
        return { ok: true as const };
      },
    });
  }
}
