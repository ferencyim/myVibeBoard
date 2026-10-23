import type { OwnedSubscription, PaseoAgent, PaseoAgentListResult } from "@getpaseo/client";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { taskConversationPanelRpc } from "../../shared/task-conversation";
import type { TaskPhase } from "../../shared/vibe/contract";
import { recipientOptions, suggestedRole } from "./logic";

type RecipientClient = Pick<PluginClientContext, "paseo" | "rpc" | "setTaskConversationRecipients">;

/** Owns selector data independently of whether the task panel is open. */
export function registerTaskRecipients(client: RecipientClient) {
  const lifetime = new AbortController();
  const members = new Map<string, string>();
  const archived = new Set<string>();
  const tasks = new Map<
    string,
    { workspaceId: string; phase?: TaskPhase; initialized?: boolean }
  >();
  let directory: OwnedSubscription<PaseoAgentListResult> | undefined;
  let unsubscribe: (() => void) | undefined;
  let subscribing = false;
  let refreshing = false;

  function removeMember(agentId: string) {
    const conversationId = members.get(agentId);
    members.delete(agentId);
    if (!conversationId || [...members.values()].includes(conversationId)) return;
    const task = tasks.get(conversationId);
    tasks.delete(conversationId);
    if (task && !lifetime.signal.aborted)
      client.setTaskConversationRecipients({
        workspaceId: task.workspaceId,
        conversationId,
        recipients: [],
      });
  }

  function remember(agent: PaseoAgent) {
    if (agent.archivedAt) {
      removeMember(agent.id);
      return false;
    }
    if (!agent.taskConversationId || !agent.workspaceId) return false;
    if (archived.has(agent.taskConversationId)) return false;
    members.set(agent.id, agent.taskConversationId);
    if (tasks.has(agent.taskConversationId)) return false;
    tasks.set(agent.taskConversationId, { workspaceId: agent.workspaceId });
    return true;
  }

  async function refresh() {
    if (refreshing || lifetime.signal.aborted || !directory?.subscriptionId) return;
    refreshing = true;
    try {
      for (const [conversationId, task] of tasks) {
        if (lifetime.signal.aborted || !directory.subscriptionId) break;
        try {
          const snapshot = await client.rpc(taskConversationPanelRpc, {
            workspaceId: task.workspaceId,
            conversationId,
          });
          if (
            lifetime.signal.aborted ||
            !directory.subscriptionId ||
            tasks.get(conversationId) !== task
          )
            continue;
          if (snapshot.conversationStatus === "archived") {
            archived.add(conversationId);
            tasks.delete(conversationId);
            client.setTaskConversationRecipients({
              workspaceId: task.workspaceId,
              conversationId,
              recipients: [],
            });
            continue;
          }
          const phase = snapshot.task?.phase;
          const suggestion =
            snapshot.suggestedRecipientId ??
            snapshot.recipients.find((option) => option.role === suggestedRole(phase))?.id;
          const changedPhase = !task.initialized || task.phase !== phase;
          client.setTaskConversationRecipients({
            workspaceId: task.workspaceId,
            conversationId,
            recipients: recipientOptions(snapshot),
            ...(changedPhase && suggestion ? { selectedRecipientId: suggestion } : {}),
          });
          task.phase = phase;
          task.initialized = true;
        } catch {
          /* A disconnected host or a different owner cannot supply these options. */
        }
      }
    } finally {
      refreshing = false;
    }
  }

  async function observe() {
    if (subscribing || directory || lifetime.signal.aborted) return;
    subscribing = true;
    try {
      const result = await client.paseo.agents.list({
        scope: "active",
        includeBackground: true,
        page: { limit: 200 },
        subscribe: {},
        signal: lifetime.signal,
      });
      if (lifetime.signal.aborted) {
        await result.subscription.release();
        return;
      }
      directory = result.subscription;
      unsubscribe = directory.subscribe({
        snapshot(snapshot) {
          for (const { agent } of snapshot.entries) remember(agent);
          void refresh();
        },
        update(message) {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") {
            if (remember(message.payload.agent)) void refresh();
          } else removeMember(message.payload.agentId);
        },
      });
      let cursor = result.pageInfo.nextCursor;
      while (cursor && !lifetime.signal.aborted && directory.subscriptionId) {
        const next = await client.paseo.agents.list({
          scope: "active",
          includeBackground: true,
          page: { limit: 200, cursor },
          signal: lifetime.signal,
        });
        for (const { agent } of next.entries) remember(agent);
        cursor = next.pageInfo.nextCursor;
      }
      await refresh();
    } catch {
      /* The existing owned subscription resumes after reconnect; initial failures retry. */
    } finally {
      subscribing = false;
    }
  }

  const timer = setInterval(() => {
    void observe();
    void refresh();
  }, 4000);
  void observe();
  return async () => {
    lifetime.abort();
    clearInterval(timer);
    unsubscribe?.();
    await directory?.release();
    members.clear();
    tasks.clear();
    archived.clear();
  };
}
