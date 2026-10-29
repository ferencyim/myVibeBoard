import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginProjectSidebarItemProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectBotsListRpc, projectBotsCreateRpc, projectBotsOpenRpc } from "../shared/project-bots";

export function ProjectAgentSidebarItem({ projectId, theme, openAgent }: PluginProjectSidebarItemProps) {
  const list = useRpc(projectBotsListRpc);
  const create = useRpc(projectBotsCreateRpc);
  const open = useRpc(projectBotsOpenRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bots = useQuery({ queryKey: ["vibe-bots", "project", projectId], queryFn: () => list({ projectId }), refetchInterval: 15000 });
  async function run(id?: string) {
    setBusy(true);
    setError("");
    try {
      let botId = id;
      if (!botId) {
        const result = await create({ kind: "project", projectId, name: "项目 bot" });
        botId = result.bot.id;
        await client.invalidateQueries({ queryKey: ["vibe-bots"] });
      }
      const result = await open({ id: botId });
      openAgent(result.agentId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const text = { color: theme.colors.foreground };
  const row = { paddingHorizontal: 24, paddingVertical: 8, opacity: busy ? 0.5 : 1 };
  return (
    <View>
      {(bots.data?.bots ?? []).map((bot) => <Pressable accessibilityRole="button" key={bot.id} disabled={busy} style={row} onPress={() => void run(bot.id)}><Text style={text}>{bot.isDefault ? "★ " : ""}{bot.name}</Text></Pressable>)}
      <Pressable accessibilityRole="button" disabled={busy} style={row} onPress={() => void run()}><Text style={text}>{busy ? "正在打开…" : "+ 新建项目 bot"}</Text></Pressable>
      {bots.isLoading ? <Text style={{ ...text, paddingHorizontal: 24 }}>正在加载 bot…</Text> : null}
      {bots.error ? <Pressable accessibilityRole="button" style={row} onPress={() => void bots.refetch()}><Text style={text}>重新加载项目 bot</Text></Pressable> : null}
      {error || bots.error ? <Text style={{ color: theme.colors.statusDanger, paddingHorizontal: 24 }}>{error || String(bots.error)}</Text> : null}
    </View>
  );
}
