import { useRpc, type PluginSidebarGroupProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { botsArchiveRpc, botsListRpc, botsOpenRpc, botsStateRpc } from "../shared/rpc";

export function IndependentBotsSidebar(props: PluginSidebarGroupProps) {
  const list = useRpc(botsListRpc);
  const query = useQuery({ queryKey: ["vibe-bots", props.host.id, "independent"], queryFn: () => list({ kind: "independent" }), refetchInterval: 15000 });
  const styles = useMemo(() => ({ muted: { color: props.theme.colors.foregroundMuted }, danger: { color: props.theme.colors.statusDanger } }), [props.theme]);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  return <View>{query.data?.bots.map((bot) => <BotRow key={bot.id} {...props} bot={bot} />)}
    {query.isLoading ? <Text style={styles.muted}>正在加载…</Text> : null}
    {query.error ? <Pressable onPress={retry}><Text style={styles.danger}>加载失败，点击重试</Text></Pressable> : null}
  </View>;
}

function BotRow({ bot, theme, host, navigation, sidebarCompact, Avatar, StatusIndicator, agents, requestAgentPreview }: PluginSidebarGroupProps & { bot: import("../shared/vibe/contract/bots").Bot }) {
  const open = useRpc(botsOpenRpc);
  const read = useRpc(botsStateRpc);
  const archive = useRpc(botsArchiveRpc);
  const client = useQueryClient();
  const key = useMemo(() => ["vibe-bots", host.id, "state", bot.id], [host.id, bot.id]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => { if (bot.mainAgentId) requestAgentPreview(bot.mainAgentId); }, [bot.mainAgentId, requestAgentPreview]);
  const activity = agents.find((agent) => agent.agentId === bot.mainAgentId);

  const state = useQuery({ queryKey: key, queryFn: () => read({ id: bot.id }), refetchInterval: (query) => query.state.data?.status === "creating" ? 1000 : 15000 });
  const navigate = useCallback((agentId: string) => navigation?.openAgent({ agentId, serverId: host.id }), [navigation, host.id]);
  useEffect(() => {
    if (pending && state.data?.status === "ready" && state.data.agentId) {
      setPending(false);
      navigate(state.data.agentId);
    } else if (pending && state.data?.status === "failed") {
      setPending(false);
    }
  }, [pending, state.data, navigate]);
  const styles = useMemo(() => ({ row: { minHeight: 54, paddingHorizontal: 12, flexDirection: "row" as const, alignItems: "center" as const, gap: 8 }, names: { flex: 1 }, text: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted }, danger: { color: theme.colors.statusDanger } }), [theme]);
  const run = useCallback(async () => {
    setOpening(true); setError("");
    try {
      const result = await open({ id: bot.id });
      client.setQueryData(key, result);
      if (result.status === "ready" && result.agentId) navigate(result.agentId);
      else if (result.status === "creating") setPending(true);
      else if (result.error) setError(result.error);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOpening(false); }
  }, [open, bot.id, client, key, navigate]);
  const profile = useCallback(() => navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } }), [navigation, bot.id]);
  const showMenu = useCallback(() => setMenu(true), []);
  const contextMenu = useMemo(() => ({ onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); showMenu(); } }), [showMenu]);
  const archiveBot = useCallback(() => { void archive({ id: bot.id }).then(() => client.invalidateQueries({ queryKey: ["vibe-bots", host.id, "independent"] })).catch((reason) => setError(String(reason))); setMenu(false); }, [archive, bot.id, client, host.id]);
  const openProfile = useCallback(() => { setMenu(false); profile(); }, [profile]);
  const onPress = useCallback(() => { setMenu(false); void run(); }, [run]);
  const closeMenu = useCallback(() => setMenu(false), []);
  const status = state.data?.status === "failed" || error ? "failed" : activity?.status;
  return <View><Pressable {...contextMenu} accessibilityRole="button" accessibilityLabel={bot.name} disabled={opening || state.data?.status === "creating"} onPress={onPress} onLongPress={showMenu} style={styles.row}>
    <Avatar seed={bot.avatarSeed || bot.id} name={bot.name} hue={bot.avatarHue} size={36} />
    {status ? <StatusIndicator status={status} count={activity?.count} /> : null}
    {!sidebarCompact && <BotDetails bot={bot} activity={activity} loading={opening || state.data?.status === "creating"} theme={theme} />}
  </Pressable>{menu ? <View><Pressable onPress={onPress}><Text style={styles.text}>打开</Text></Pressable><Pressable onPress={openProfile}><Text style={styles.text}>资料 / 改名</Text></Pressable><Pressable onPress={archiveBot}><Text style={styles.danger}>归档</Text></Pressable><Pressable onPress={closeMenu}><Text style={styles.muted}>取消</Text></Pressable></View> : null}{error || state.data?.error ? <Text style={styles.danger}>{error || state.data?.error}</Text> : null}</View>;
}

function BotDetails({ bot, activity, loading, theme }: { bot: import("../shared/vibe/contract/bots").Bot; activity?: import("@getpaseo/plugin/client").PluginSidebarAgentActivity; loading: boolean; theme: PluginSidebarGroupProps["theme"] }) {
  const styles = useMemo(() => ({ names: { flex: 1 }, text: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted } }), [theme]);
  const time = activity?.lastMessage ? new Date(activity.lastMessage.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  return <View style={styles.names}><Text style={styles.text}>{bot.name}{time ? ` · ${time}` : ""}</Text><Text numberOfLines={1} style={styles.muted}>{loading ? "正在创建…" : [bot.title, activity?.lastMessage?.text].filter(Boolean).join(" · ")}</Text></View>;
}
