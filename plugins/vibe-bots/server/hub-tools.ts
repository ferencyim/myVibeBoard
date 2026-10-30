import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { BotService } from "./service";
import type { BotMessaging } from "./messages";

const HUB_PLUGIN = "vibe-scheduler";
const scope = z.union([
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("projects"), projectIds: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("providers"), providers: z.array(z.string().min(1)).min(1) }),
]);

/** Hub tools (coordinator main conversation only) and the bot message tool (every bot). */
export function registerHubTools(server: PluginServerContext, service: BotService, messaging: BotMessaging) {
  async function coordinator(agentId: string | null | undefined) {
    const bot = await service.caller(agentId);
    if (bot.role !== "coordinator" || bot.mainAgentId !== agentId) {
      throw new Error("此工具只给总协调 bot 的主对话使用");
    }
    return bot;
  }
  async function hub(method: string, input: unknown) {
    try {
      return await server.paseo.plugins.invoke(HUB_PLUGIN, method, input);
    } catch (error) {
      throw new Error(`中枢暂不可用或不支持 ${method}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function tool<S extends z.ZodType>(name: string, description: string, method: string, input?: S) {
    server.registerAgentTool({
      name, description, ...(input ? { input } : {}),
      handler: async (value, ctx) => {
        await coordinator(ctx.callerAgentId);
        return hub(method, input ? input.parse(value) : {});
      },
    });
  }
  tool("vibe_hub_status", "读取中枢状态：机器指标、排队、持有者、等待原因、生效中的暂停与指令。", "hub.status");
  tool("vibe_hub_queue", "调整中枢统一队列的顺序（agent 任务与重任务同一队列），必须写明理由；不会绕过资源准入。", "hub.queue.reorder",
    z.object({ order: z.array(z.string().min(1)), reason: z.string().trim().min(1) }).strict());
  tool("vibe_hub_pause", "按范围开启暂停或维护窗口（scope 如 pg:*、build、test、all-heavy），到期自动解除。", "hub.pause.create",
    z.object({ scope: z.string().min(1), until: z.string().min(1).describe("ISO 时间，不超过 24 小时后"), reason: z.string().trim().min(1) }).strict());
  tool("vibe_hub_resume", "提前解除一条暂停规则。", "hub.pause.revoke", z.object({ id: z.string().min(1) }).strict());
  tool("vibe_directive_issue", "下发全局指令。临时运维指令有效期不超过 24 小时并立即生效；长期规则只会进入待确认，由用户决定。", "hub.directive.issue",
    z.object({
      text: z.string().min(1).max(4000), kind: z.enum(["temporary", "standing"]), scope: scope.optional(),
      expiresAt: z.string().nullable().optional(),
      pause: z.object({ scope: z.string().min(1), until: z.string().optional() }).optional(),
    }).strict());
  tool("vibe_directive_list", "列出全局指令，可按状态筛选。", "hub.directive.list",
    z.object({ status: z.enum(["active", "pending", "revoked", "expired"]).optional() }).strict());
  tool("vibe_directive_revoke", "撤销一条全局指令。", "hub.directive.revoke", z.object({ id: z.string().min(1) }).strict());

  const message = z.object({
    to: z.union([z.string().min(1), z.object({ projectId: z.string().min(1) }).strict()])
      .describe('bot id、"coordinator"，或 {projectId} 发给该项目默认 bot'),
    text: z.string().trim().min(1).max(8000),
  }).strict();
  server.registerAgentTool({
    name: "vibe_bot_message",
    description: "给其它 bot 发消息，投递为对方主对话里标明发送方的系统来源消息，对方忙时回合结束后送达。项目 bot 只能发给总协调和本项目的 bot。",
    input: message,
    handler: async (input, ctx) => {
      const sender = await service.caller(ctx.callerAgentId);
      const value = message.parse(input);
      return messaging.send(sender, value.to, value.text);
    },
  });
}
