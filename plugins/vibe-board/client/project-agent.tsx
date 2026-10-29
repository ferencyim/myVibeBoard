import { BotCreateForm } from "./create-form";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc, type PluginClientContext, type PluginProjectSidebarGroupProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectBotsListRpc, projectBotsCreateRpc, projectBotsOpenRpc, projectBotsStateRpc, projectBotsArchiveRpc } from "../shared/project-bots";
import { createProjectAgentRequest, deactivateProjectAgentRequest, openProjectAgentRequest, projectAgentPollInterval, projectAgentPresentation, receiveProjectAgentState, projectBotWorkspaceProjection } from "./project-agent-sidebar";

type BotRowProps = PluginProjectSidebarGroupProps & { bot: import("../shared/vibe/contract/bots").Bot & { isDefault: boolean }; autoOpen: boolean };

function useBotStyles(theme: PluginProjectSidebarGroupProps["theme"]) {
  return useMemo(() => StyleSheet.create({
    row: { paddingHorizontal: 12, minHeight: 54, flexDirection: "row", alignItems: "center", gap: 8 },
    names: { flex: 1 },
    muted: { color: theme.colors.foregroundMuted },
    text: { color: theme.colors.foreground },
    loading: { color: theme.colors.foreground, paddingHorizontal: 24 },
    error: { color: theme.colors.statusDanger, paddingHorizontal: 24 },
  }), [theme]);
}

function ProjectBotRow({ bot, theme, navigation, host, sidebarCompact, Avatar, StatusIndicator, agents, requestAgentPreview, autoOpen }: BotRowProps) {
  const openAgent = useCallback((agentId: string) => navigation?.openAgent({ agentId, serverId: host.id }), [navigation, host.id]);
  useEffect(() => { if (bot.mainAgentId) requestAgentPreview(bot.mainAgentId); }, [bot.mainAgentId, requestAgentPreview]);
  const activity = agents.find((agent) => agent.agentId === bot.mainAgentId);
  const lastMessageTime = activity?.lastMessage ? new Date(activity.lastMessage.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  const archive = useRpc(projectBotsArchiveRpc);
  const [menu, setMenu] = useState(false);
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
  const profile = useCallback(() => { setMenu(false); navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } }); }, [navigation, bot.id]);
  const archiveBot = useCallback(() => { setMenu(false); void archive({ id: bot.id }).then(() => client.invalidateQueries({ queryKey: ["vibe-bots", "project"] })).catch((reason) => setOpenError(String(reason))); }, [archive, bot.id, client]);
  const closeMenu = useCallback(() => setMenu(false), []);
  const status = error ? "failed" : activity?.status;
  return <View>
    <Pressable {...contextMenu} accessibilityRole="button" accessibilityLabel={`${bot.name}：${label}`} disabled={disabled} style={styles.row} onPress={run} onLongPress={showMenu}>
      <Avatar seed={bot.avatarSeed || bot.id} name={bot.name} hue={bot.avatarHue} size={36} />
      {status ? <StatusIndicator status={status} count={activity?.count} /> : null}
      {!sidebarCompact ? <View style={styles.names}><Text style={styles.text}>{bot.isDefault ? "★ " : ""}{bot.name}{lastMessageTime ? ` · ${lastMessageTime}` : ""}</Text><Text numberOfLines={1} style={styles.muted}>{label !== bot.name ? label : [bot.title, activity?.lastMessage?.text].filter(Boolean).join(" · ")}</Text></View> : null}
    </Pressable>
    {menu ? <View><Pressable onPress={run}><Text style={styles.text}>打开</Text></Pressable><Pressable onPress={profile}><Text style={styles.text}>资料 / 改名</Text></Pressable><Pressable onPress={archiveBot}><Text style={styles.error}>归档</Text></Pressable><Pressable onPress={closeMenu}><Text style={styles.muted}>取消</Text></Pressable></View> : null}
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
  const showForm = useCallback(() => setCreating(true), []);
  const hideForm = useCallback(() => setCreating(false), []);
  const submitForm = useCallback((value: Omit<Parameters<typeof create>[0], "kind" | "projectId">) => { void add({ ...value, kind: "project", projectId }); }, [add, projectId]);
  return <View>
    {(bots.data?.bots ?? []).map((bot) => <ProjectBotRow key={`${projectId}:${bot.id}`} {...props} bot={bot} autoOpen={created?.projectId === projectId && created.botId === bot.id} />)}
    <Pressable accessibilityRole="button" disabled={busy} style={styles.row} onPress={showForm}><Text style={styles.text}>{busy ? "正在新建…" : "+ 新建项目 bot"}</Text></Pressable>
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
