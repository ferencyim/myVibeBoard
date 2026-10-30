import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { queueOrderRpc } from "../shared/rpc";
import type { SchedulerRuntime } from "./runtime";

const IndependentBotsSchema = z.object({
  bots: z.array(z.object({ mainAgentId: z.string().nullable(), role: z.string().nullable().optional() })),
});

/** Scheduler tools (queue order, read) belong to the coordinator bot only. */
export async function requireIndependentBot(
  callerAgentId: string | null,
  invoke: (pluginId: string, method: string, input: unknown) => Promise<unknown>,
): Promise<void> {
  if (!callerAgentId) throw new Error("调度工具只能由总协调 bot 调用");
  const result = await invoke("vibe-bots", "bots.list", { kind: "independent" });
  const { bots } = IndependentBotsSchema.parse(result);
  if (!bots.some((bot) => bot.mainAgentId === callerAgentId && bot.role === "coordinator")) {
    throw new Error("只有总协调 bot 的主对话可以使用调度工具");
  }
}

export function registerBotTools(
  server: PluginServerContext,
  runtime: SchedulerRuntime,
  getPaseo: () => PaseoApi | null,
) {
  async function authorize(callerAgentId: string | null) {
    const paseo = getPaseo();
    if (!paseo) throw new Error("宿主尚未连接，请稍后重试");
    await requireIndependentBot(callerAgentId, (pluginId, method, input) =>
      paseo.plugins.invoke(pluginId, method, input),
    );
  }
  server.registerAgentTool({
    name: "vibe_scheduler_read",
    description: "bot 读取当前调度状态、已确认等待队列、资源与等待原因，用于向用户解释。",
    handler: async (_input, { callerAgentId }) => {
      await authorize(callerAgentId);
      return {
        ...runtime.scheduler.status(),
        resources: runtime.latest(),
        quota: runtime.quota(),
      };
    },
  });
  server.registerAgentTool({
    name: "vibe_queue_reorder",
    description:
      "仅在用户明确要求时调整已确认等待任务的顺序，并填写用户要求与调整理由。未列出的任务随后按确认时间 FIFO；空列表恢复全部 FIFO。不会派发任务或绕过资源准入。",
    input: queueOrderRpc.input.strict(),
    handler: async (input, { callerAgentId }) => {
      await authorize(callerAgentId);
      const value = queueOrderRpc.input.parse(input);
      return runtime.scheduler.setQueueOrder(value.workspaceIds, value.reason);
    },
  });
}
