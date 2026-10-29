import { useAgent, useRpc, type PluginConversationHeaderAccessoryProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { botsOpenRpc, threadsArchiveRpc, threadsCreateRpc, threadsListRpc, threadsOpenRpc, threadsRenameRpc } from "../shared/rpc";

export function ThreadTabs(props: PluginConversationHeaderAccessoryProps) {
  const labels = useAgent(props.agentId, (agent) => agent.labels);
  const botId = labels?.["vibe.bot"];
  const threadId = labels?.["vibe.bot-thread"];
  if (!botId || !threadId) return null;
  return <Tabs {...props} botId={botId} threadId={threadId} />;
}

function Tabs({ botId, threadId, theme, tokens, navigation }: PluginConversationHeaderAccessoryProps & { botId: string; threadId: string }) {
  const list = useRpc(threadsListRpc);
  const create = useRpc(threadsCreateRpc);
  const rename = useRpc(threadsRenameRpc);
  const archive = useRpc(threadsArchiveRpc);
  const open = useRpc(threadsOpenRpc);
  const openMain = useRpc(botsOpenRpc);
  const queryClient = useQueryClient();
  const key = ["vibe-bots", "threads", botId];
  const query = useQuery({ queryKey: key, queryFn: () => list({ botId }), refetchInterval: 15000 });
  const [edit, setEdit] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const active = useRef(true);
  useEffect(() => { if (edit) scroll.current?.scrollTo({ x: 0, animated: false }); }, [edit]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run(action: () => Promise<void>) {
    setPending(true); setError(null);
    try { await action(); } catch (e) { if (active.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current) setPending(false); }
  }
  async function navigate(id: string) {
    await run(async () => {
      let result = id === "main" ? await openMain({ id: botId }) : await open({ botId, id });
      while (result.status === "creating" && active.current) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!active.current) return;
        result = id === "main" ? await openMain({ id: botId }) : await open({ botId, id });
      }
      if (result.status === "failed") throw new Error(result.error ?? "无法打开旁线程");
      if (result.agentId && active.current) navigation?.openAgent({ agentId: result.agentId });
    });
  }
  const threads = query.data?.threads.filter((thread) => !thread.archivedAt) ?? [];
  const styles = useMemo(() => ({
    container: { flex: 1, minWidth: 0 },
    row: { flexDirection: "row" as const, alignItems: "center" as const },
    input: { minWidth: tokens.spacing[3] * 8, height: tokens.spacing[3] * 3, color: theme.colors.foreground, borderWidth: tokens.borderWidth[1], borderColor: theme.colors.border, paddingHorizontal: tokens.spacing[2], paddingVertical: 0, fontSize: tokens.fontSize.md },
    muted: { color: theme.colors.foregroundMuted, fontSize: tokens.fontSize.md },
    error: { color: theme.colors.statusDanger },
    buttons: [false, true].flatMap((selected) => [false, true].map((disabled) => ({
      state: { selected, disabled },
      style: { paddingHorizontal: tokens.spacing[3], height: tokens.spacing[3] * 3, justifyContent: "center" as const, borderBottomWidth: selected ? tokens.borderWidth[2] : 0, borderColor: theme.colors.accent, opacity: disabled ? tokens.opacity.disabled : tokens.opacity[100] },
      text: { maxWidth: tokens.spacing[3] * 8, fontSize: tokens.fontSize.md, color: selected ? theme.colors.foreground : theme.colors.foregroundMuted },
    }))),
  }), [theme, tokens]);
  function button(label: string, onPress: () => void, selected = false, disabled = false) {
    const item = styles.buttons[(selected ? 2 : 0) + (pending || disabled ? 1 : 0)];
    return <Pressable accessibilityRole="button" accessibilityState={item.state} disabled={pending || disabled} onPress={onPress} style={item.style}><Text numberOfLines={1} style={item.text}>{label}</Text></Pressable>;
  }
  return <View style={styles.container}>
    <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        {edit ? <>
          <TextInput accessibilityLabel="旁线程名称" value={title} onChangeText={setTitle} maxLength={200} style={styles.input} />
          {button("保存", () => { void run(async () => { if (edit === "new") { const result = await create({ botId, title: title.trim() }); setEdit(null); await queryClient.invalidateQueries({ queryKey: key }); await navigate(result.thread.id); } else { await rename({ botId, id: edit, title: title.trim() }); setEdit(null); await queryClient.invalidateQueries({ queryKey: key }); } }); }, false, !title.trim())}
          {button("取消", () => setEdit(null))}
        </> : <>
          {button("主对话", () => { void navigate("main"); }, threadId === "main")}
          {threads.map((thread) => <View key={thread.id} style={styles.row}>
            {button(thread.title, () => { void navigate(thread.id); }, threadId === thread.id)}
            {threadId === thread.id ? <>{button("改名", () => { setEdit(thread.id); setTitle(thread.title); })}{button("归档", () => { void run(async () => { await archive({ botId, id: thread.id }); await queryClient.invalidateQueries({ queryKey: key }); await navigate("main"); }); })}</> : null}
          </View>)}
          {button("＋", () => { setEdit("new"); setTitle(""); }, false, threads.length >= 8)}
        </>}
        {query.isLoading ? <Text style={styles.muted}>正在加载旁线程…</Text> : null}
        {error || query.error ? <Text accessibilityRole="alert" numberOfLines={1} style={styles.error}>{error ?? "加载旁线程失败"}</Text> : null}
      </View>
    </ScrollView>
  </View>;
}
