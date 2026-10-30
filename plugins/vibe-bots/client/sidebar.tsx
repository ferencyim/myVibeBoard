import { useRpc, type PluginSidebarGroupProps } from "@getpaseo/plugin/client";
import { ActionMenu, type ActionMenuItem } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { BotCreateForm } from "./create-form";
import { formatRelativeTime } from "./relative-time";
import { botsArchiveRpc, botsCreateRpc, botsListRpc, botsOpenRpc, botsStateRpc } from "../shared/rpc";

export function IndependentBotsSidebar(props: PluginSidebarGroupProps) {
  const list = useRpc(botsListRpc);
  const create = useRpc(botsCreateRpc);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { createRequest, onCreateHandled } = props;
  useEffect(() => { if (createRequest) { setCreating(true); onCreateHandled?.(); } }, [createRequest, onCreateHandled]);
  const cancel = useCallback(() => setCreating(false), []);
  const submit = useCallback((value: Omit<Parameters<typeof create>[0], "kind" | "projectId">) => {
    setBusy(true); setError("");
    void create({ ...value, kind: "independent" }).then(() => { setCreating(false); return client.invalidateQueries({ queryKey: ["vibe-bots", props.host.id, "independent"] }); }).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false));
  }, [create, client, props.host.id]);
  const query = useQuery({ queryKey: ["vibe-bots", props.host.id, "independent"], queryFn: () => list({ kind: "independent" }), refetchInterval: 15000 });
  const styles = useMemo(() => ({ muted: { color: props.theme.colors.foregroundMuted }, danger: { color: props.theme.colors.statusDanger } }), [props.theme]);
  const { onItemsChange, agents } = props;
  const activityKey = JSON.stringify(agents);
  const stableAgents = useMemo(() => JSON.parse(activityKey) as typeof agents, [activityKey]);
  const rows = useMemo(() => (query.data?.bots ?? []).toSorted((a, b) => Number(b.role === "coordinator") - Number(a.role === "coordinator")).map((bot) => {
    const activity = stableAgents.find((agent) => agent.agentId === bot.mainAgentId);
    let status: "needs_attention" | "running" | "idle" = "idle";
    if (activity?.status === "waiting") status = "needs_attention";
    else if (activity?.status === "working") status = "running";
    return {
      id: bot.id, kind: "bot" as const, projectId: null,
      lastActivityAt: activity?.lastMessage?.timestamp ?? bot.updatedAt,
      status,
      agentId: bot.mainAgentId,
      render: ({ projectName, selected }: { projectName?: string; selected?: boolean }) => <BotRow projectName={projectName} selected={selected} key={bot.id} theme={props.theme} host={props.host} navigation={props.navigation} sidebarCompact={props.sidebarCompact} Avatar={props.Avatar} StatusIndicator={props.StatusIndicator} agents={stableAgents} requestAgentPreview={props.requestAgentPreview} bot={bot} />,
    };
  }), [query.data, stableAgents, props.theme, props.host, props.navigation, props.sidebarCompact, props.Avatar, props.StatusIndicator, props.requestAgentPreview]);
  useEffect(() => { onItemsChange?.(rows); }, [onItemsChange, rows]);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  return <View>{creating ? <BotCreateForm theme={props.theme} busy={busy} error={error} onCancel={cancel} onSubmit={submit} /> : null}{!onItemsChange && (query.data?.bots ?? []).toSorted((a, b) => Number(b.role === "coordinator") - Number(a.role === "coordinator")).map((bot) => <BotRow key={bot.id} {...props} bot={bot} />)}
    {query.isLoading ? <Text style={styles.muted}>正在加载…</Text> : null}
    {query.error ? <Pressable onPress={retry}><Text style={styles.danger}>加载失败，点击重试</Text></Pressable> : null}
  </View>;
}

function BotRow({ bot, theme, host, navigation, sidebarCompact, Avatar, StatusIndicator, agents, requestAgentPreview, projectName, selected }: Pick<PluginSidebarGroupProps, "theme" | "host" | "navigation" | "sidebarCompact" | "Avatar" | "StatusIndicator" | "agents" | "requestAgentPreview"> & { bot: import("../shared/vibe/contract/bots").Bot; projectName?: string; selected?: boolean }) {
  const open = useRpc(botsOpenRpc);
  const read = useRpc(botsStateRpc);
  const archive = useRpc(botsArchiveRpc);
  const client = useQueryClient();
  const key = useMemo(() => ["vibe-bots", host.id, "state", bot.id], [host.id, bot.id]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
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
  const styles = useMemo(() => ({ row: { minHeight: 36, paddingVertical: 4, paddingHorizontal: (theme.spacing?.[2] ?? 8), borderRadius: (theme.borderRadius?.md ?? 8), flexDirection: "row" as const, alignItems: "center" as const, gap: (theme.spacing?.[2] ?? 8) }, names: { flex: 1 }, text: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted }, danger: { color: theme.colors.statusDanger } }), [theme]);
  const run = useCallback(async () => {
    // 点击立即响应：已有主 agent 直接跳转；没有则先显示资料页（身份可见），创建完成后自动接上对话。
    if (bot.mainAgentId) navigate(bot.mainAgentId);
    else navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } });
    setOpening(true); setError("");
    try {
      const result = await open({ id: bot.id });
      client.setQueryData(key, result);
      if (result.status === "ready" && result.agentId) { if (result.agentId !== bot.mainAgentId) navigate(result.agentId); }
      else if (result.status === "creating") setPending(true);
      else if (result.error) setError(result.error);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOpening(false); }
  }, [open, bot.id, bot.mainAgentId, client, key, navigate, navigation]);
  const profile = useCallback(() => navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } }), [navigation, bot.id]);
  const showMenu = useCallback(() => setMenu(true), []);
  const contextMenu = useMemo(() => ({ onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); showMenu(); } }), [showMenu]);
  const archiveBot = useCallback(() => { void archive({ id: bot.id }).then(() => client.invalidateQueries({ queryKey: ["vibe-bots", host.id, "independent"] })).catch((reason) => setError(String(reason))); }, [archive, bot.id, client, host.id]);
  const items = useMemo<ActionMenuItem[]>(() => [
    { id: "open", label: "打开" },
    { id: "profile", label: "资料" },
    { id: "archive", label: "归档", destructive: true, confirm: { title: "归档 bot", message: `确定归档「${bot.name}」吗？`, confirmLabel: "归档" } },
  ], [bot.name]);
  const selectItem = useCallback((id: string) => { if (id === "open") void run(); else if (id === "profile") profile(); else if (id === "archive") archiveBot(); }, [run, profile, archiveBot]);
  const onPress = useCallback(() => { setMenu(false); void run(); }, [run]);
  const rowStyle = useMemo(() => [styles.row, selected && { backgroundColor: theme.colors.surface2 }], [styles.row, selected, theme.colors.surface2]);
  const status = state.data?.status === "failed" || error ? "failed" : activity?.status;
  return <View><Pressable {...contextMenu} accessibilityRole="button" accessibilityLabel={bot.name} onPress={onPress} onLongPress={showMenu} onHoverIn={hoverIn} onHoverOut={hoverOut} style={rowStyle}>
    <Avatar seed={bot.avatarSeed || bot.id} name={bot.name} hue={bot.avatarHue} size={24} />
    {!sidebarCompact && <BotDetails bot={bot} activity={activity} loading={!bot.mainAgentId && (opening || state.data?.status === "creating")} theme={theme} projectName={projectName} />}
    {status ? <StatusIndicator status={status} count={activity?.count} /> : null}
    <ActionMenu label={`${bot.name}菜单`} items={items} onSelect={selectItem} open={menu} onOpenChange={setMenu} visible={Platform.OS !== "web" || hovered || menu} />
  </Pressable>{error || state.data?.error ? <Text style={styles.danger}>{error || state.data?.error}</Text> : null}</View>;
}

function BotDetails({ bot, activity, loading, theme, projectName }: { projectName?: string; bot: import("../shared/vibe/contract/bots").Bot; activity?: import("@getpaseo/plugin/client").PluginSidebarAgentActivity; loading: boolean; theme: PluginSidebarGroupProps["theme"] }) {
  const styles = useMemo(() => ({ names: { flex: 1 }, head: { flexDirection: "row" as const, alignItems: "center" as const, gap: (theme.spacing?.[2] ?? 8) }, name: { flex: 1, color: theme.colors.foreground }, text: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted } }), [theme]);
  const time = formatRelativeTime(activity?.lastMessage?.timestamp ?? bot.updatedAt);
  const sub = loading ? "正在创建…" : projectName ?? (bot.role === "coordinator" ? [bot.title, "中枢与项目协调"].find((t) => t && t !== bot.name) : undefined);
  return <View style={styles.names}><View style={styles.head}><Text numberOfLines={1} style={styles.name}>{bot.name}</Text>{time ? <Text style={styles.muted}>{time}</Text> : null}</View>{sub ? <Text numberOfLines={1} style={styles.muted}>{sub}</Text> : null}</View>;
}
