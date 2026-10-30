import { BotCreateForm } from "./create-form";
import { formatRelativeTime } from "./relative-time";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ActionMenu, type ActionMenuItem } from "@getpaseo/plugin/client/ui";
import { useRpc, type PluginClientContext, type PluginProjectSidebarGroupProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectBotsListRpc, projectBotsCreateRpc, projectBotsOpenRpc, projectBotsStateRpc, projectBotsArchiveRpc } from "../shared/project-bots";
import { createProjectAgentRequest, deactivateProjectAgentRequest, openProjectAgentRequest, projectAgentPollInterval, projectAgentPresentation, receiveProjectAgentState, projectBotWorkspaceProjection } from "./project-agent-sidebar";

type BotRowProps = Pick<PluginProjectSidebarGroupProps, "theme" | "host" | "navigation" | "sidebarCompact" | "Avatar" | "StatusIndicator" | "agents" | "requestAgentPreview"> & { bot: import("../shared/vibe/contract/bots").Bot & { isDefault: boolean }; autoOpen: boolean; projectName?: string; selected?: boolean };

function useBotStyles(theme: PluginProjectSidebarGroupProps["theme"]) {
  return useMemo(() => StyleSheet.create({
    row: { minHeight: 36, paddingVertical: 4, paddingHorizontal: (theme.spacing?.[2] ?? 8), borderRadius: (theme.borderRadius?.md ?? 8), flexDirection: "row", alignItems: "center", gap: (theme.spacing?.[2] ?? 8) },
    badge: { color: theme.colors.foregroundMuted, backgroundColor: theme.colors.surface2, borderRadius: (theme.borderRadius?.md ?? 8), overflow: "hidden" },
    names: { flex: 1 },
    head: { flexDirection: "row", alignItems: "center", gap: (theme.spacing?.[2] ?? 8) },
    name: { flex: 1, color: theme.colors.foreground },
    muted: { color: theme.colors.foregroundMuted },
    text: { color: theme.colors.foreground },
    loading: { color: theme.colors.foreground, paddingHorizontal: 24 },
    error: { color: theme.colors.statusDanger, paddingHorizontal: 24 },
  }), [theme]);
}

function ProjectBotRow({ bot, theme, navigation, host, sidebarCompact, Avatar, StatusIndicator, agents, requestAgentPreview, autoOpen, projectName, selected }: BotRowProps) {
  const openAgent = useCallback((agentId: string) => navigation?.openAgent({ agentId, serverId: host.id }), [navigation, host.id]);
  useEffect(() => { if (bot.mainAgentId) requestAgentPreview(bot.mainAgentId); }, [bot.mainAgentId, requestAgentPreview]);
  const activity = agents.find((agent) => agent.agentId === bot.mainAgentId);
  const lastMessageTime = formatRelativeTime(activity?.lastMessage?.timestamp ?? bot.updatedAt);
  const archive = useRpc(projectBotsArchiveRpc);
  const [menu, setMenu] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const open = useRpc(projectBotsOpenRpc);
  const read = useRpc(projectBotsStateRpc);
  const client = useQueryClient();
  const styles = useBotStyles(theme);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const request = useMemo(() => createProjectAgentRequest(bot.id, "项目 bot"), [bot.id]);
  const queryKey = useMemo(() => ["vibe-bots", "state", bot.id], [bot.id]);
  useEffect(() => {
    request.active = true;
    return () => deactivateProjectAgentRequest(request);
  }, [request]);
  const state = useQuery({ queryKey, queryFn: () => read({ id: bot.id }), refetchInterval: (query) => projectAgentPollInterval(query.state.data), staleTime: 15_000 });
  useEffect(() => { receiveProjectAgentState(request, state.data, openAgent); }, [request, state.data, openAgent]);
  const run = useCallback(() => { void openProjectAgentRequest(request, {
    cancelQueries: () => client.cancelQueries({ queryKey }),
    open: (id) => open({ id }),
    setState: (result) => client.setQueryData(queryKey, result),
    setOpening, setError: setOpenError, openAgent,
  }); }, [request, client, queryKey, open, openAgent]);
  useEffect(() => {
    if (autoOpen && !autoOpened.current) {
      autoOpened.current = true;
      run();
    }
  }, [autoOpen, run]);
  const { label, error, disabled } = projectAgentPresentation(state.data, opening, openError, bot.name);
  const showMenu = useCallback(() => setMenu(true), []);
  const contextMenu = useMemo(() => ({ onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); showMenu(); } }), [showMenu]);
  const profile = useCallback(() => { navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } }); }, [navigation, bot.id]);
  const archiveBot = useCallback(() => { void archive({ id: bot.id }).then(() => client.invalidateQueries({ queryKey: ["vibe-bots", "project"] })).catch((reason) => setOpenError(String(reason))); }, [archive, bot.id, client]);
  const items = useMemo<ActionMenuItem[]>(() => [
    { id: "open", label: "打开" },
    { id: "profile", label: "资料" },
    { id: "archive", label: "归档", destructive: true, confirm: { title: "归档 bot", message: `确定归档「${bot.name}」吗？`, confirmLabel: "归档" } },
  ], [bot.name]);
  const selectItem = useCallback((id: string) => { if (id === "open") run(); else if (id === "profile") profile(); else if (id === "archive") archiveBot(); }, [run, profile, archiveBot]);
  const rowStyle = useMemo(() => [styles.row, selected && { backgroundColor: theme.colors.surface2 }], [styles.row, selected, theme.colors.surface2]);
  const status = error ? "failed" : activity?.status;
  return <View>
    <Pressable {...contextMenu} accessibilityRole="button" accessibilityLabel={`${bot.name}：${label}`} disabled={disabled} style={rowStyle} onPress={run} onLongPress={showMenu} onHoverIn={hoverIn} onHoverOut={hoverOut}>
      <Avatar seed={bot.avatarSeed || bot.id} name={bot.name} hue={bot.avatarHue} size={24} />
      {!sidebarCompact ? <View style={styles.names}><View style={styles.head}><Text numberOfLines={1} style={styles.name}>{bot.name}{bot.isDefault ? <Text style={styles.badge}> 默认 </Text> : null}</Text>{lastMessageTime ? <Text style={styles.muted}>{lastMessageTime}</Text> : null}</View>{projectName || (label !== bot.name && label) ? <Text numberOfLines={1} style={styles.muted}>{projectName || label}</Text> : null}</View> : null}
      {status ? <StatusIndicator status={status} count={activity?.count} /> : null}
      <ActionMenu label={`${bot.name}菜单`} items={items} onSelect={selectItem} open={menu} onOpenChange={setMenu} visible={Platform.OS !== "web" || hovered || menu} />
    </Pressable>
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </View>;
}

export function ProjectAgentSidebarItem(props: PluginProjectSidebarGroupProps) {
  return <ProjectBotList key={props.projectId} {...props} />;
}

function ProjectBotList(props: PluginProjectSidebarGroupProps) {
  const { projectId, theme } = props;
  const styles = useBotStyles(theme);
  const list = useRpc(projectBotsListRpc);
  const create = useRpc(projectBotsCreateRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ projectId: string; botId: string } | null>(null);
  const bots = useQuery({ queryKey: ["vibe-bots", "project", props.host.id, projectId], queryFn: () => list({ projectId }), refetchInterval: 15000 });
  const add = useCallback(async (value: Parameters<typeof create>[0]) => {
    setBusy(true);
    setError("");
    try {
      const result = await create(value);
      setCreated({ projectId, botId: result.bot.id });
      setCreating(false);
      await client.invalidateQueries({ queryKey: ["vibe-bots"] });
    } catch {
      setError("暂时无法新建项目 bot，请重试。");
    } finally { setBusy(false); }
  }, [create, projectId, client]);
  const retry = useCallback(() => { void bots.refetch(); }, [bots]);
  const { createRequest, onCreateHandled } = props;
  useEffect(() => { if (createRequest) { setCreating(true); onCreateHandled?.(); } }, [createRequest, onCreateHandled]);
  const { onItemsChange, agents } = props;
  const activityKey = JSON.stringify(agents);
  const stableAgents = useMemo(() => JSON.parse(activityKey) as typeof agents, [activityKey]);
  const rows = useMemo(() => (bots.data?.bots ?? []).map((bot) => {
    const activity = stableAgents.find((agent) => agent.agentId === bot.mainAgentId);
    let status: "needs_attention" | "running" | "idle" = "idle";
    if (activity?.status === "waiting") status = "needs_attention";
    else if (activity?.status === "working") status = "running";
    return {
      id: bot.id, kind: "bot" as const, projectId, isDefaultBot: bot.isDefault,
      lastActivityAt: activity?.lastMessage?.timestamp ?? bot.updatedAt,
      status,
      agentId: bot.mainAgentId,
      render: ({ projectName, selected }: { projectName?: string; selected?: boolean }) => <ProjectBotRow projectName={projectName} selected={selected} key={`${projectId}:${bot.id}`} theme={props.theme} host={props.host} navigation={props.navigation} sidebarCompact={props.sidebarCompact} Avatar={props.Avatar} StatusIndicator={props.StatusIndicator} agents={stableAgents} requestAgentPreview={props.requestAgentPreview} bot={bot} autoOpen={created?.projectId === projectId && created.botId === bot.id} />,
    };
  }), [bots.data, stableAgents, projectId, created, props.theme, props.host, props.navigation, props.sidebarCompact, props.Avatar, props.StatusIndicator, props.requestAgentPreview]);
  useEffect(() => { onItemsChange?.(rows); }, [onItemsChange, rows]);
  const hideForm = useCallback(() => setCreating(false), []);
  const submitForm = useCallback((value: Omit<Parameters<typeof create>[0], "kind" | "projectId">) => { void add({ ...value, kind: "project", projectId }); }, [add, projectId]);
  return <View>
    {!onItemsChange && (bots.data?.bots ?? []).map((bot) => <ProjectBotRow key={`${projectId}:${bot.id}`} {...props} bot={bot} autoOpen={created?.projectId === projectId && created.botId === bot.id} />)}
    {creating ? <BotCreateForm error={error} theme={theme} projectId={projectId} busy={busy} onCancel={hideForm} onSubmit={submitForm} /> : null}
    {bots.isLoading ? <Text style={styles.loading}>正在加载 bot…</Text> : null}
    {bots.error ? <Pressable accessibilityRole="button" style={styles.row} onPress={retry}><Text style={styles.text}>重新加载项目 bot</Text></Pressable> : null}
    {error || bots.error ? <Text style={styles.error}>{error || "暂时无法加载项目 bot，请重试。"}</Text> : null}
  </View>;
}

export function contributeProjectBotWorkspaces(client: PluginClientContext) {
  return client.addSidebarWorkspaceProvider({
    id: "project-bot-workspaces",
    async resolve({ projectId, workspaceIds }) {
      const { bots } = await client.rpc(projectBotsListRpc, { projectId });
      return projectBotWorkspaceProjection(bots.map((bot) => bot.id), workspaceIds, (id) => client.rpc(projectBotsStateRpc, { id }));
    },
  });
}
