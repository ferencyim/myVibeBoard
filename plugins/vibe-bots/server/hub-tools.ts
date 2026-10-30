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

const pauseInput = z.object({
  scope: z.string().min(1),
  until: z.string().min(1).describe("ISO 时间，不超过 24 小时后"),
  reason: z.string().trim().min(1).max(1000),
}).strict();
const directiveInput = z.object({
  text: z.string().min(1).max(4000), kind: z.enum(["temporary", "standing"]), scope: scope.optional(),
  expiresAt: z.string().nullable().optional(),
  pause: z.object({ scope: z.string().min(1), until: z.string().optional() }).optional(),
}).strict();

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
  tool("vibe_hub_queue", "调整中枢统一队列的顺序（order 为排队条目 id：重任务 jobId 与 agent 任务 workspaceId，按期望顺序），可用 priorities（jobId -> 0-9，越小越优先）改重任务优先级，必须写明理由；不会绕过资源准入。", "hub.queue.reorder",
    z.object({
      order: z.array(z.string().min(1)).max(1000),
      priorities: z.record(z.string(), z.number().int().min(0).max(9)).optional(),
      reason: z.string().trim().min(1).max(1000),
    }).strict());
  server.registerAgentTool({
    name: "vibe_hub_pause",
    description: "按范围开启暂停或维护窗口：scope 为 all-heavy（全部重任务）、build、test、deploy、db、agents（新 agent 任务）、project:项目名，或资源名/通配（如 pg:*）；到期自动解除。必须给 until（ISO 时间，不超过 24 小时后）和理由。",
    input: pauseInput,
    handler: async (value, ctx) => {
      await coordinator(ctx.callerAgentId);
      return hub("hub.pause.create", { ...pauseInput.parse(value), issuedBy: "bot" });
    },
  });
  server.registerAgentTool({
    name: "vibe_hub_resume",
    description: "提前解除一条暂停规则（id 来自 vibe_hub_status）。用户自己设置的暂停不能由 bot 解除。",
    input: z.object({ id: z.string().min(1) }).strict(),
    handler: async (value, ctx) => {
      await coordinator(ctx.callerAgentId);
      const { id } = z.object({ id: z.string().min(1) }).parse(value);
      const listed = (await hub("hub.pause.list", { activeOnly: true })) as { pauses?: Array<{ id: string; issuedBy?: string }> };
      if (listed.pauses?.find((p) => p.id === id)?.issuedBy === "user") throw new Error("bot 不能解除用户设置的暂停");
      return hub("hub.pause.revoke", { id });
    },
  });
  server.registerAgentTool({
    name: "vibe_directive_issue",
    description: "下发全局指令。临时运维指令（须带 expiresAt，不超过 24 小时）立即生效并通知用户；长期规则（standing）只会进入待确认，由用户决定。需要强制暂停时带 pause（范围同 vibe_hub_pause）。",
    input: directiveInput,
    handler: async (value, ctx) => {
      await coordinator(ctx.callerAgentId);
      return hub("hub.directive.issue", { ...directiveInput.parse(value), asBot: true });
    },
  });
  tool("vibe_directive_list", "列出全局指令，可按状态筛选。", "hub.directive.list",
    z.object({ status: z.enum(["active", "pending", "revoked", "expired"]).optional() }).strict());
  server.registerAgentTool({
    name: "vibe_directive_revoke",
    description: "撤销一条全局指令；用户下发的指令不能由 bot 撤销。",
    input: z.object({ id: z.string().min(1) }).strict(),
    handler: async (value, ctx) => {
      await coordinator(ctx.callerAgentId);
      const { id } = z.object({ id: z.string().min(1) }).parse(value);
      return hub("hub.directive.revoke", { id, asBot: true });
    },
  });

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

  const held = z.object({ action: z.enum(["list", "release"]), botId: z.string().min(1).optional() }).strict();
  server.registerAgentTool({
    name: "vibe_bot_held",
    description: "被防循环拦下（同一对 bot 10 分钟内超过 6 条）的 bot 消息：list 查看，release 判断不是循环后放行并重新投递（可用 botId 只处理与某个 bot 有关的）。放行后该窗口内同一对 bot 再发仍可能被拦。仅总协调使用。",
    input: held,
    handler: async (input, ctx) => {
      await coordinator(ctx.callerAgentId);
      const value = held.parse(input);
      if (value.action === "release") return messaging.releaseHeld(value.botId);
      return {
        held: messaging.listHeld(value.botId).map((row) => ({
          id: row.id, from: row.from_bot_id, to: row.to_bot_id, text: row.text.slice(0, 500), createdAt: row.created_at,
        })),
      };
    },
  });
}
