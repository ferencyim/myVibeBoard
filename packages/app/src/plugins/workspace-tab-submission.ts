import type { PluginWorkspaceTabProvider } from "@getpaseo/plugin/client";
import type { DaemonClient, SendMessageOptions } from "@getpaseo/client/internal/daemon-client";

/** Keep delivery in the host client: plugin-origin messages cannot authorize execution. */
export async function submitWorkspaceTabMessage(input: {
  provider: PluginWorkspaceTabProvider;
  workspaceId: string;
  tabId: string;
  config: Omit<Parameters<PluginWorkspaceTabProvider["create"]>[0], "workspaceId" | "tabId">;
  client: Pick<
    DaemonClient,
    "fetchAgent" | "sendAgentMessage" | "setAgentModel" | "setAgentThinkingOption"
  >;
  text: string;
  options: Omit<SendMessageOptions, "sourceAgentId" | "sourceAgentServerId">;
}) {
  const { agentId } = await input.provider.create({
    workspaceId: input.workspaceId,
    tabId: input.tabId,
    ...input.config,
  });
  const snapshot = await input.client.fetchAgent(agentId);
  if (!snapshot) throw new Error("会话已创建但暂时无法读取，请重试发送。");
  let agent = snapshot.agent;
  if (agent.provider !== input.config.provider)
    throw new Error("该流程会话已由后台建立，模型来源已变化。请在会话中切换模型后重发。");
  if (input.config.model && agent.model !== input.config.model) {
    await input.client.setAgentModel(agentId, input.config.model);
    agent = { ...agent, model: input.config.model };
  }
  if (input.config.thinkingOptionId && agent.thinkingOptionId !== input.config.thinkingOptionId) {
    await input.client.setAgentThinkingOption(agentId, input.config.thinkingOptionId);
    agent = { ...agent, thinkingOptionId: input.config.thinkingOptionId };
  }
  await input.client.sendAgentMessage(agentId, input.text, input.options);
  return agent;
}
