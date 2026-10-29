import { BotCreateForm } from "./create-form";
import { useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, StyleSheet } from "react-native";
import { botsListRpc, botsCreateRpc, botsArchiveRpc } from "../shared/rpc";
import { useBotConversation } from "./use-bot-conversation";

export function MasterScreen({ theme, navigation }: PluginScreenProps) {
  const list = useRpc(botsListRpc);
  const create = useRpc(botsCreateRpc);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["vibe-bots", "independent"], queryFn: () => list({ kind: "independent" }), refetchInterval: 15000 });
  const act = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await client.invalidateQueries({ queryKey: ["vibe-bots"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [client]);
  const styles = useMemo(() => StyleSheet.create({
    text: { color: theme.colors.foreground },
    muted: { color: theme.colors.foregroundMuted },
    danger: { color: theme.colors.statusDanger },
    button: { padding: 10, opacity: busy ? 0.5 : 1 },
    page: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: 16, gap: 12 },
    input: { color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 },
  }), [theme, busy]);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  const createBot = useCallback((value: Parameters<typeof create>[0]) => { void act(async () => { await create(value); setCreating(false); }); }, [act, create]);
  const showForm = useCallback(() => setCreating(true), []);
  const hideForm = useCallback(() => setCreating(false), []);
  const submitForm = useCallback((value: Omit<Parameters<typeof create>[0], "kind" | "projectId">) => createBot({ ...value, kind: "independent" }), [createBot]);
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.text}>bot</Text>
      <Text style={styles.muted}>不属于任何项目的独立 bot；在资料中填写角色说明，决定它做什么。</Text>
      {query.isLoading ? <Text style={styles.text}>正在加载…</Text> : null}
      {query.error ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
      {query.error ? <Pressable accessibilityRole="button" style={styles.button} onPress={retry}><Text style={styles.text}>重新加载</Text></Pressable> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {(query.data?.bots ?? []).map((bot) => <BotRow key={bot.id} bot={bot} theme={theme} navigation={navigation} busy={busy} />)}
      {query.data?.bots.length === 0 ? <Text style={styles.text}>还没有 bot，请新建。</Text> : null}
      <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={showForm}><Text style={styles.text}>+ 新建 bot</Text></Pressable>
      {creating ? <BotCreateForm error={error} theme={theme} busy={busy} onCancel={hideForm} onSubmit={submitForm} /> : null}
    </ScrollView>
  );
}

interface BotRowProps extends Pick<PluginScreenProps, "theme" | "navigation"> {
  bot: import("../shared/vibe/contract/bots").Bot;
  busy: boolean;
}
function BotRow({ bot, theme, navigation, busy }: BotRowProps) {
  const openAgent = useCallback((id: string) => navigation?.openAgent({ agentId: id }), [navigation]);
  const conversation = useBotConversation(bot.id, openAgent);
  const archive = useRpc(botsArchiveRpc);
  const client = useQueryClient();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const styles = useMemo(() => StyleSheet.create({
    card: { borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 12, gap: 6 },
    identity: { flexDirection: "row", alignItems: "center", gap: 12 },
    avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: `hsl(${bot.avatarHue}, 45%, 35%)` },
    names: { flex: 1 }, text: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted },
    danger: { color: theme.colors.statusDanger }, actions: { flexDirection: "row", flexWrap: "wrap" },
    button: { padding: 10, opacity: busy || working ? 0.5 : 1 },
  }), [theme, bot.avatarHue, busy, working]);
  const act = useCallback(async (action: () => Promise<unknown>) => {
    setWorking(true); setError("");
    try { await action(); await client.invalidateQueries({ queryKey: ["vibe-bots"] }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }, [client]);
  const openBot = useCallback(() => { void conversation.open(); }, [conversation]);
  const profile = useCallback(() => { navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } }); }, [navigation, bot.id]);
  const archiveBot = useCallback(() => { void act(() => archive({ id: bot.id })); }, [act, archive, bot.id]);
  return <View style={styles.card}>
    <View style={styles.identity}>
      <View style={styles.avatar}><Text style={styles.text}>{Array.from(bot.name)[0]}</Text></View>
      <View style={styles.names}><Text style={styles.text}>{bot.name}</Text><Text style={styles.muted}>{bot.title}</Text></View>
    </View>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" disabled={busy || working || conversation.disabled || !navigation} style={styles.button} onPress={openBot}><Text style={styles.text}>{conversation.label}</Text></Pressable>
      {navigation?.openPluginScreen ? <Pressable accessibilityRole="button" disabled={busy || working} style={styles.button} onPress={profile}><Text style={styles.text}>资料 / 改名 / 记忆</Text></Pressable> : null}
      <Pressable accessibilityRole="button" disabled={busy || working} style={styles.button} onPress={archiveBot}><Text style={styles.danger}>归档</Text></Pressable>
    </View>
    {error ? <Text style={styles.danger}>{error}</Text> : null}
    {conversation.error ? <Text style={styles.danger}>{conversation.error}</Text> : null}
  </View>;
}

export function PromptLibrarySidebarItem({ openPromptLibrary, isPromptLibraryActive }: PluginSidebarItemProps) {
  return <SidebarRow icon="BookOpen" label="提示词仓库" active={isPromptLibraryActive} onPress={openPromptLibrary} />;
}

export function MasterSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const openBots = useCallback(() => { openScreen({ screenId: "main" }); }, [openScreen]);
  return <SidebarRow icon="Bot" label="bot" active={currentScreen?.screenId === "main"} onPress={openBots} />;
}
