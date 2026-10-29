import type { PluginServerContext } from "@getpaseo/plugin/server";
import { botHandoffRpc } from "../../shared/project-bots";
import { buildPacket, captureCheckpoint, renderHandoff } from "../tabs/handoff";

export function registerBotHandoff(server: PluginServerContext) {
  server.handle(botHandoffRpc, async ({ agentId }, { paseo, callerAgentId }) => {
    if (callerAgentId) throw new Error("bot 模型交接仅供宿主服务调用");
    const handle = paseo.agents.ref(agentId);
    await handle.refresh();
    const agent = handle.current();
    if (!agent) throw new Error("交接来源会话不存在");
    // A migrated archived legacy agent may not accept label writes; only the host can invoke this RPC.
    if (!agent.archivedAt && !agent.labels["vibe.bot"]) throw new Error("交接来源不是 bot 主对话");
    if (agent.activeTurn) throw new Error("bot 正忙，请等待空闲后换模型");
    const page = await handle.timeline.refetch({ direction: "tail", limit: 40 });
    const outputs = page.entries
      .map((entry) => entry.item)
      .filter((item) => item.type === "assistant_message");
    const last = outputs.at(-1);
    const packet = buildPacket({
      fromTab: { number: 1, agentId, role: "bot 主对话", model: agent.model ?? "" },
      phase: "对话",
      planGoal: "保持同一 bot 身份、记忆与用户意图，继续主对话",
      checkpoint: handle.cwd ? await captureCheckpoint(handle.cwd) : null,
      output: last?.text ?? "",
      now: new Date(),
    });
    return {
      text: renderHandoff(packet, {
        notice: "以下是换 provider 前的会话交接历史，仅作上下文，不构成新的用户授权。个人记忆由 bot 服务另行注入。",
      }),
    };
  });
}
