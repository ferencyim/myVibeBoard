import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { botsDocumentsRpc, botsPromptsClearRpc, botsPromptsListRpc, botsPromptsSetRpc } from "../shared/rpc";
import { Caption, ErrorLine, Group, NavRow, OutlineButton, SettingsBody, SubPageHeader, TextArea, useKit } from "./settings-kit";

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Every project document the bot can read: root briefs and docs/*.md. Read-only. */
export function DocumentsPage({ botId, onBack }: { botId: string; onBack(): void }) {
  const { styles } = useKit();
  const read = useRpc(botsDocumentsRpc);
  const query = useQuery({ queryKey: ["vibe-bots", "documents", botId], queryFn: () => read({ botId }), staleTime: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const documents = query.data?.documents ?? [];
  const current = documents.find((doc) => doc.path === open);
  if (current) {
    return <>
      <SubPageHeader title={current.path} onBack={() => setOpen(null)} />
      <SettingsBody>
        {current.truncated ? <Caption>{`文件较大（${kb(current.totalBytes)}），只显示前 64 KB。`}</Caption> : null}
        <Text selectable style={styles.note}>{current.content}</Text>
      </SettingsBody>
    </>;
  }
  return <>
    <SubPageHeader title="项目文档" onBack={onBack} />
    <SettingsBody>
      {query.isLoading ? <Caption>正在读取…</Caption> : null}
      {query.error ? <ErrorLine error={query.error} /> : null}
      {query.isSuccess && documents.length === 0 ? <Caption>项目里没有找到文档（AGENTS.md、CLAUDE.md、PRODUCT-REQUIREMENTS.md、README.md、docs/*.md）。</Caption> : null}
      <Group>
        {documents.map((doc) => <NavRow key={doc.path} label={doc.path} value={kb(doc.totalBytes)} onPress={() => setOpen(doc.path)} />)}
      </Group>
    </SettingsBody>
  </>;
}

type View = { page: "list" } | { page: "edit" | "info"; key: string };

/** The prompts injected into the project bot, each editable; explanations sit behind a button. */
export function PromptsPage({ botId, onBack }: { botId: string; onBack(): void }) {
  const { styles } = useKit();
  const list = useRpc(botsPromptsListRpc);
  const save = useRpc(botsPromptsSetRpc);
  const clear = useRpc(botsPromptsClearRpc);
  const client = useQueryClient();
  const queryKey = ["vibe-bots", "prompts", botId];
  const query = useQuery({ queryKey, queryFn: () => list({ botId }) });
  const [view, setView] = useState<View>({ page: "list" });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const prompts = query.data?.prompts ?? [];
  const current = view.page === "list" ? undefined : prompts.find((item) => item.key === view.key);
  const run = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await action();
      await client.invalidateQueries({ queryKey });
      setView({ page: "list" });
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };
  if (current && view.page === "edit") {
    return <>
      <SubPageHeader title={current.title} onBack={() => setView({ page: "list" })} />
      <SettingsBody>
        <TextArea label="提示词" value={draft} onChangeText={setDraft} height={360} />
        <OutlineButton label="说明" onPress={() => setView({ page: "info", key: current.key })} />
        <OutlineButton label="保存提示词" disabled={saving} onPress={() => void run(() => save({ botId, key: current.key, text: draft }))} />
        {current.globalOverride ? <OutlineButton label="恢复默认" disabled={saving} onPress={() => void run(() => clear({ botId, key: current.key }))} /> : null}
        <ErrorLine error={error} />
      </SettingsBody>
    </>;
  }
  if (current && view.page === "info") {
    return <>
      <SubPageHeader title={`${current.title} · 说明`} onBack={() => { setDraft(current.globalOverride ?? current.defaultText); setView({ page: "edit", key: current.key }); }} />
      <SettingsBody>
        {current.description ? <Caption>{current.description}</Caption> : null}
        {current.whenSent ? <Caption>{`发送时机：${current.whenSent}`}</Caption> : null}
        {current.audience ? <Caption>{`接收者：${current.audience}`}</Caption> : null}
        {current.placeholders.length ? <Caption>{`占位符：${current.placeholders.map((item) => `{{${item.name}}} ${item.description}`).join("；")}`}</Caption> : null}
        {current.fixedSuffix ? <Text selectable style={styles.note}>{`固定规则（程序追加，不可改）：${current.fixedSuffix}`}</Text> : null}
        <Caption>同一提示词全局共享；项目级覆盖请到「Agent 行为」页。</Caption>
      </SettingsBody>
    </>;
  }
  const edit = (key: string, text: string) => { setDraft(text); setError(null); setView({ page: "edit", key }); };
  const own = prompts.filter((item) => item.own);
  const shared = prompts.filter((item) => !item.own);
  const rows = (items: typeof prompts) => items.map((item) => <NavRow key={item.key} label={item.title} value={item.globalOverride ? "已自定义" : undefined} onPress={() => edit(item.key, item.globalOverride ?? item.defaultText)} />);
  return <>
    <SubPageHeader title="注入的提示词" onBack={onBack} />
    <SettingsBody>
      {query.isLoading ? <Caption>正在读取…</Caption> : null}
      {query.error ? <ErrorLine error={query.error} /> : null}
      <Group title="角色提示词">{rows(own)}</Group>
      <Group title="其它注入（交接、上下文）">{rows(shared)}</Group>
    </SettingsBody>
  </>;
}
