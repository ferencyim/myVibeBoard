import { randomUUID } from "node:crypto";
import type { ModelGroup, ProviderUsage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import type { AgentManager } from "./agent-manager.js";
import {
  MODEL_GROUP_LABEL,
  MODEL_GROUP_ORDER_LABEL,
  selectModelGroupEntry,
} from "./model-groups.js";

// Provider error messages vary; keep the recognized capacity and availability failures together.
const FAILOVER_ERROR =
  /(?:\b(?:quota|rate[\s_-]*limit(?:ed)?|too many requests|overload(?:ed)?|capacity|resource exhausted|insufficient credits?|usage limit|model[^\n]{0,80}(?:unavailable|not available|not found|does not exist)|(?:unavailable|not available)[^\n]{0,80}model)\b|\b429\b|额度|配额|限流|过载|模型.{0,20}(?:不可用|不存在))/i;

export function isModelGroupFailoverError(error: string): boolean {
  return FAILOVER_ERROR.test(error);
}

type Manager = Pick<
  AgentManager,
  | "subscribe"
  | "getAgent"
  | "getForegroundPrompt"
  | "getForegroundPromptGeneration"
  | "getProviderAvailability"
  | "setAgentModel"
  | "setAgentThinkingOption"
  | "updateAgentMetadata"
  | "createAgent"
  | "appendTimelineItem"
  | "streamAgent"
>;

export function registerModelGroupFailover(options: {
  agentManager: Manager;
  getGroups: () => ModelGroup[];
  getUsage: () => Promise<ProviderUsage[]>;
  logger: pino.Logger;
}): () => void {
  const { agentManager, logger } = options;
  const handling = new Set<string>();
  return agentManager.subscribe(
    (message) => {
      if (message.type !== "agent_stream" || message.event.type !== "turn_failed") return;
      const event = message.event;
      if (
        !isModelGroupFailoverError(
          [event.error, event.code, event.diagnostic].filter(Boolean).join(" "),
        )
      )
        return;
      const agent = agentManager.getAgent(message.agentId);
      const failedPrompt = agentManager.getForegroundPrompt(message.agentId, event.turnId);
      const generation = agentManager.getForegroundPromptGeneration(message.agentId);
      const groupId = agent?.labels[MODEL_GROUP_LABEL];
      const orderValue = agent?.labels[MODEL_GROUP_ORDER_LABEL];
      if (!agent || !groupId || orderValue === undefined || handling.has(agent.id)) return;
      if (failedPrompt === undefined) {
        logger.warn(
          { agentId: agent.id, turnId: event.turnId },
          "Cannot safely identify the failed model group prompt",
        );
        return;
      }
      const order = Number(orderValue);
      if (!Number.isFinite(order) || !agent.config.model) return;
      handling.add(agent.id);
      let ownsLock = true;
      void (async () => {
        const group = options.getGroups().find((candidate) => candidate.id === groupId);
        if (!group) return;
        const { entry } = await selectModelGroupEntry(
          group,
          (provider) => agentManager.getProviderAvailability(provider),
          await options.getUsage().catch(() => []),
          {
            order,
            provider: agent.provider,
            model: agent.config.model!,
          },
        );
        if (!entry) return;
        // Do not redirect a newer user turn while selection was in progress.
        const current = agentManager.getAgent(agent.id);
        if (
          !current ||
          current.lifecycle === "running" ||
          current.labels[MODEL_GROUP_LABEL] !== groupId ||
          current.labels[MODEL_GROUP_ORDER_LABEL] !== orderValue ||
          agentManager.getForegroundPromptGeneration(agent.id) !== generation
        )
          return;
        const labels = { ...current.labels, [MODEL_GROUP_ORDER_LABEL]: String(entry.order) };
        let targetId = current.id;
        if (entry.provider === current.provider) {
          await agentManager.setAgentModel(current.id, entry.model);
          await agentManager.setAgentThinkingOption(current.id, entry.thinkingOptionId ?? null);
          await agentManager.updateAgentMetadata(current.id, { labels });
        } else {
          const successor = await agentManager.createAgent(
            {
              ...current.config,
              provider: entry.provider,
              model: entry.model,
              thinkingOptionId: entry.thinkingOptionId,
              // Provider-specific settings cannot safely be carried to another provider.
              providerOptions: undefined,
            },
            undefined,
            { workspaceId: current.workspaceId, owner: current.owner, labels },
          );
          targetId = successor.id;
        }
        await agentManager.appendTimelineItem(current.id, {
          type: "notification",
          level: "info",
          message: `Model group switched to ${entry.provider}/${entry.model}${targetId === current.id ? "" : ` (agent ${targetId})`}.`,
        });
        if (targetId !== current.id) {
          await agentManager.appendTimelineItem(targetId, {
            type: "notification",
            level: "info",
            message: `Continued from agent ${current.id} after a model group switch.`,
          });
        }
        handling.delete(agent.id);
        ownsLock = false;
        for await (const _event of agentManager.streamAgent(targetId, failedPrompt, {
          clientMessageId: randomUUID(),
        })) {
          // Consume the stream to drive the successor turn.
        }
      })()
        .catch((error) =>
          logger.warn({ err: error, agentId: agent.id }, "Model group failover failed"),
        )
        .finally(() => {
          if (ownsLock) handling.delete(agent.id);
        });
    },
    { replayState: false },
  );
}
