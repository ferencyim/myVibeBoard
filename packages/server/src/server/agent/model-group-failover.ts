import { randomUUID } from "node:crypto";
import type { ModelGroup, ProviderUsage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import type { AgentManager } from "./agent-manager.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import {
  MODEL_GROUP_LABEL,
  MODEL_GROUP_ORDER_LABEL,
  isProviderExhausted,
  selectModelGroupEntry,
} from "./model-groups.js";

// Overload, rate limit and model-unavailable failures are usually temporary: retry the same entry
// after these delays and only then move to the next one. Quota exhaustion is decided from the
// subscription usage report instead of the error text.
const DEFAULT_RETRY_DELAYS_MS = [15_000, 45_000, 120_000];

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
  /**
   * Continues an agent's conversation on another provider: converts or summarizes its history into
   * a new agent. Returns null when that is unavailable, and the failed prompt alone moves over.
   */
  switchProvider?: (input: {
    agentId: string;
    provider: string;
    modelId: string;
  }) => Promise<{ agentId: string } | null>;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): () => void {
  const { agentManager, logger } = options;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const handling = new Set<string>();
  const retries = new Map<string, number>();

  // Nobody sent a newer message while the retry was waiting.
  function isStillWaiting(agentId: string, generation: number): boolean {
    const waiting = agentManager.getAgent(agentId);
    return (
      Boolean(waiting) &&
      waiting!.lifecycle !== "running" &&
      agentManager.getForegroundPromptGeneration(agentId) === generation
    );
  }

  // Consume the stream so the resent turn actually runs.
  async function drive(agentId: string, prompt: AgentPromptInput): Promise<void> {
    for await (const _event of agentManager.streamAgent(agentId, prompt, {
      clientMessageId: randomUUID(),
    })) {
      // Events reach subscribers through the manager.
    }
  }
  return agentManager.subscribe(
    (message) => {
      if (message.type !== "agent_stream") return;
      if (message.event.type === "turn_completed") retries.delete(message.agentId);
      if (message.event.type !== "turn_failed") return;
      const event = message.event;
      const transient = isModelGroupFailoverError(
        [event.error, event.code, event.diagnostic].filter(Boolean).join(" "),
      );
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
        const usage = await options.getUsage().catch(() => []);
        if (!isProviderExhausted(usage, agent.provider)) {
          const used = retries.get(agent.id) ?? 0;
          if (!transient) return;
          if (used < retryDelaysMs.length) {
            retries.set(agent.id, used + 1);
            await sleep(retryDelaysMs[used]!);
            if (!isStillWaiting(agent.id, generation)) {
              retries.delete(agent.id);
              return;
            }
            handling.delete(agent.id);
            ownsLock = false;
            await drive(agent.id, failedPrompt);
            return;
          }
        }
        retries.delete(agent.id);
        const { entry } = await selectModelGroupEntry(
          group,
          (provider) => agentManager.getProviderAvailability(provider),
          usage,
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
          const switched = await options.switchProvider?.({
            agentId: current.id,
            provider: entry.provider,
            modelId: entry.model,
          });
          if (switched) {
            // The successor carries the conversation; keep it in the group.
            targetId = switched.agentId;
            if (entry.thinkingOptionId)
              await agentManager.setAgentThinkingOption(targetId, entry.thinkingOptionId);
            await agentManager.updateAgentMetadata(targetId, { labels });
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
        await drive(targetId, failedPrompt);
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
