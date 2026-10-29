import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Text, View, StyleSheet } from "react-native";
import { botsListRpc } from "../shared/rpc";
import { Button, Feedback, Page } from "./ui";

export function BotsScreen({ theme, navigation }: PluginScreenProps) {
  const list = useRpc(botsListRpc);
  const query = useQuery({ queryKey: ["vibe-bots", "list"], queryFn: () => list({}), refetchInterval: 15000 });
  const styles = useMemo(() => StyleSheet.create({ title: { color: theme.colors.foreground, fontSize: 20 }, muted: { color: theme.colors.foregroundMuted } }), [theme]);
  const retry = useCallback(() => { void query.refetch(); }, [query]);
  return <Page theme={theme}>
    <Text style={styles.title}>bot 资料与记忆</Text>
    <Feedback theme={theme} error={query.error} message={query.isLoading ? "正在加载…" : "项目 bot 可在项目侧栏新建；bot 可在「bot」页新建。"} />
    {query.data?.bots.map((bot) => <BotProfileRow key={bot.id} bot={bot} theme={theme} navigation={navigation} />)}
    {query.data?.bots.length === 0 ? <Text style={styles.muted}>还没有 bot。</Text> : null}
    {query.error ? <Button theme={theme} label="重试" onPress={retry} /> : null}
  </Page>;
}
interface BotProfileRowProps extends Pick<PluginScreenProps, "theme" | "navigation"> {
  bot: import("../shared/vibe/contract/bots").Bot & { isDefault: boolean };
}
function BotProfileRow({ bot, theme, navigation }: BotProfileRowProps) {
  const styles = useMemo(() => StyleSheet.create({ row: { gap: 6 }, text: { color: theme.colors.foreground } }), [theme]);
  const profile = useCallback(() => { navigation?.openPluginScreen?.({ pluginId: "vibe-bots", screenId: "profile", params: { botId: bot.id } }); }, [navigation, bot.id]);
  return <View style={styles.row}>
    <Text style={styles.text}>{bot.name}{bot.isDefault ? " ★" : ""} · {bot.kind === "independent" ? "bot" : bot.projectId}</Text>
    <Button theme={theme} label="查看资料与记忆" disabled={!navigation?.openPluginScreen} onPress={profile} />
  </View>;
}
