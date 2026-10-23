import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

/** Directory rows represent the container; member transcripts remain inside its view. */
export function collapseTaskConversationDirectory<
  T extends {
    id: string;
    serverId: string;
    taskConversationId?: string;
    labels: Record<string, string>;
  },
>(agents: readonly T[]): T[] {
  const result: T[] = [];
  const conversationPositions = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.taskConversationId) {
      result.push(agent);
      continue;
    }
    const key = `${agent.serverId}\0${agent.taskConversationId}`;
    const position = conversationPositions.get(key);
    if (position === undefined) {
      conversationPositions.set(key, result.length);
      result.push(agent);
    } else if (
      getParentAgentIdFromLabels(result[position].labels) &&
      !getParentAgentIdFromLabels(agent.labels)
    ) {
      result[position] = agent;
    }
  }
  return result;
}
