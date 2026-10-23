import { useMemo } from "react";
import { createPluginAgentActionContext, createPluginWorkspaceActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { taskConversationKey, useTaskConversationStore } from "@/task-conversations/store";
import { useSessionStore } from "@/stores/session-store";

export interface PluginClientSlashCommand {
  pluginId: string;
  name: string;
  description: string;
  argumentHint: string;
  run(args: string): Promise<void>;
}

export function usePluginClientSlashCommands(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId?: string;
  conversationId?: string;
  anchorAgentId?: string;
}): PluginClientSlashCommand[] {
  const installed = useInstalledPlugins();
  const conversation = useTaskConversationStore((state) => {
    if (!input.conversationId) return null;
    return (
      state.conversations.get(taskConversationKey(input.serverId, input.conversationId)) ?? null
    );
  });
  const anchorAvailable = useSessionStore((state) => {
    if (!input.agentId) return false;
    const session = state.sessions[input.serverId];
    return Boolean(session?.agents.has(input.agentId) || session?.agentDetails.has(input.agentId));
  });
  return useMemo(() => {
    if (!input.workspaceId) return [];
    const workspaceId = input.workspaceId;
    if (input.conversationId) {
      const matchesConversation =
        conversation?.workspaceId === workspaceId &&
        (conversation.anchorAgentId ?? undefined) === input.anchorAgentId &&
        input.agentId === input.anchorAgentId;
      if (!matchesConversation) return [];
    }
    const state = createPluginClientStateSource(input.serverId);
    const navigation = createPluginNavigation({
      serverId: input.serverId,
      workspaceId,
    });
    const commands = installed
      .filter((plugin) => plugin.serverId === input.serverId)
      .flatMap((plugin) =>
        plugin.clientSlashCommands.flatMap((contribution) => {
          if (contribution.context === "agent" && !anchorAvailable) return [];
          if (!state.getWorkspace(workspaceId)) return [];
          return [
            {
              pluginId: plugin.id,
              name: contribution.name,
              description: contribution.description,
              argumentHint: contribution.argumentHint,
              async run(args: string) {
                if (contribution.context === "agent" && !input.agentId) {
                  throw new Error("Task conversation anchor is unavailable");
                }
                const context =
                  contribution.context === "agent" && input.agentId
                    ? createPluginAgentActionContext({
                        plugin,
                        navigation,
                        state,
                        workspaceId,
                        agentId: input.agentId,
                        conversationId: input.conversationId,
                        anchorAgentId: input.anchorAgentId,
                      })
                    : createPluginWorkspaceActionContext({
                        plugin,
                        navigation,
                        state,
                        workspaceId,
                      });
                if (contribution.context === "agent" && context?.context === "agent")
                  await contribution.onSubmit({ ...context, args });
                else if (contribution.context === "workspace" && context?.context === "workspace")
                  await contribution.onSubmit({ ...context, args });
              },
            },
          ];
        }),
      );
    return commands;
  }, [
    input.agentId,
    input.serverId,
    input.workspaceId,
    input.conversationId,
    input.anchorAgentId,
    conversation,
    anchorAvailable,
    installed,
  ]);
}
