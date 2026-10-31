import { useAgent, usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { z } from "zod";
import { MaintainScreen } from "./screen";

const botsSchema = z.object({ bots: z.array(z.object({ id: z.string(), role: z.string().nullable(), mainAgentId: z.string().nullable() })) });

import { isCoordinatorConversation } from "./panel-mapping";

function useCoordinator(agentId: string) {
  const paseo = usePaseo();
  const botId = useAgent(agentId, (agent) => agent.labels["vibe.bot"]);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const query = useQuery({
    queryKey: ["vibe-maintain", "coordinator-bots"],
    queryFn: async () => botsSchema.parse(await paseo.plugins.invoke("vibe-bots", "bots.list", {})),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });
  return { workspaceId, coordinator: isCoordinatorConversation(query.data?.bots ?? [], agentId, botId ?? undefined), loading: query.isLoading };
}

export function MaintainPanel(props: PluginAgentPanelProps) {
  const { coordinator, loading } = useCoordinator(props.agentId);
  if (!coordinator) return <View style={{ padding: 16 }}><Text style={{ color: props.theme.colors.foregroundMuted }}>{loading ? "正在加载…" : "自动维护仅在总协调 bot 会话中可用。"}</Text></View>;
  return <MaintainScreen theme={props.theme} />;
}

export async function isRequiredForAgent({ agentId, botId, paseo }: Parameters<NonNullable<import("@getpaseo/plugin/client").PluginAgentPanelContribution["requiredForAgent"]>>[0]) {
  const result = botsSchema.parse(await paseo.plugins.invoke("vibe-bots", "bots.list", {}));
  return isCoordinatorConversation(result.bots, agentId, botId);
}
