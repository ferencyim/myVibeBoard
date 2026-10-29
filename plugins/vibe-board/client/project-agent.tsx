import { BotCreateForm } from "./create-form";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc, type PluginProjectSidebarItemProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectBotsListRpc, projectBotsCreateRpc, projectBotsOpenRpc, projectBotsStateRpc } from "../shared/project-bots";
import { createProjectAgentRequest, deactivateProjectAgentRequest, openProjectAgentRequest, projectAgentPollInterval, projectAgentPresentation, receiveProjectAgentState } from "./project-agent-sidebar";

type BotRowProps = PluginProjectSidebarItemProps & { bot: { id: string; name: string; isDefault: boolean }; autoOpen: boolean };

function useBotStyles(theme: PluginProjectSidebarItemProps["theme"]) {
  return useMemo(() => StyleSheet.create({
    row: { paddingHorizontal: 24, paddingVertical: 8 },
    text: { color: theme.colors.foreground },
    loading: { color: theme.colors.foreground, paddingHorizontal: 24 },
    error: { color: theme.colors.statusDanger, paddingHorizontal: 24 },
  }), [theme]);
}

function ProjectBotRow({ bot, theme, openAgent, autoOpen }: BotRowProps) {
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
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}：${label}`} disabled={disabled} style={styles.row} onPress={run}>
      <Text style={styles.text}>{bot.isDefault ? "★ " : ""}{bot.name}{label !== bot.name ? ` · ${label}` : ""}</Text>
    </Pressable>
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </View>;
}

export function ProjectAgentSidebarItem(props: PluginProjectSidebarItemProps) {
  return <ProjectBotList key={props.projectId} {...props} />;
}

function ProjectBotList(props: PluginProjectSidebarItemProps) {
  const { projectId, theme } = props;
  const styles = useBotStyles(theme);
  const list = useRpc(projectBotsListRpc);
  const create = useRpc(projectBotsCreateRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ projectId: string; botId: string } | null>(null);
  const bots = useQuery({ queryKey: ["vibe-bots", "project", projectId], queryFn: () => list({ projectId }), refetchInterval: 15000 });
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
