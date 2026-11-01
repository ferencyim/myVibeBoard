import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { promptsClearRpc, promptsListRpc, promptsSetRpc } from "../shared/rpc";
import type { TaskTabRole } from "../shared/vibe/contract";
import { useHost } from "./common/ctx";
import { errorMessage } from "./common/logic";
import { Btn, Muted, TextField } from "./common/ui";
import { injectedPromptKeys, ownPromptKeys, type PromptTarget } from "./injected-prompts";

interface ListedPrompt {
  key: string;
  title: string;
  description: string;
  whenSent: string;
  audience: string;
  defaultText: string;
  fixedSuffix: string;
  globalOverride: string | null;
  placeholders: Array<{ name: string; description: string }>;
}
type View_ = { page: "list" } | { page: "edit" | "info"; key: string };

/** The compact pill used next to the model picker in conversation headers. */
export function HeaderButton({ label, onPress, disabled, testID }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { theme } = useHost();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} testID={testID} disabled={disabled} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", height: 26, paddingHorizontal: 10, borderRadius: 999,
      borderWidth: 1, borderColor: theme.colors.border, backgroundColor: "transparent", opacity: disabled ? 0.5 : 1 }}>
    <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
  </Pressable>;
}

/** Lists every registered prompt injected into this agent; each one opens in a roomy editor. */
export function InjectedPromptsButton({ target, label }: { target: PromptTarget; label: string }) {
  const { theme } = useHost();
  const list = useRpc(promptsListRpc);
  const save = useRpc(promptsSetRpc);
  const clear = useRpc(promptsClearRpc);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View_>({ page: "list" });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const query = useQuery({ queryKey: ["vibe-board", "prompts", null], queryFn: () => list({ projectId: null }) });
  const prompts = (query.data?.prompts ?? []) as ListedPrompt[];
  const keys = injectedPromptKeys(target, prompts.map((item) => item.key));
  if (query.isSuccess && keys.length === 0) return null;
  const own = ownPromptKeys(target, prompts.map((item) => item.key));
  const byKey = new Map(prompts.map((item) => [item.key, item]));
  const rows = keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));
  const current = view.page === "list" ? undefined : byKey.get(view.key);
  const edit = (item: ListedPrompt) => { setDraft(item.globalOverride ?? item.defaultText); setError(null); setView({ page: "edit", key: item.key }); };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vibe-board", "prompts"] });
  const run = async (action: () => Promise<unknown>, done: () => void) => {
    setSaving(true);
    try { await action(); await refresh(); done(); } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  };
  const info = (item: ListedPrompt) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 说明`}
    onPress={() => setView({ page: "info", key: item.key })}
    style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", justifyContent: "center" }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>i</Text>
  </Pressable>;
  const row = (item: ListedPrompt) => <View key={item.key} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
    <Pressable accessibilityRole="button" onPress={() => edit(item)} style={{ flex: 1 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{item.title}</Text>
      {item.globalOverride ? <Text style={{ color: theme.colors.accent, fontSize: 12 }}>已自定义</Text> : null}
    </Pressable>
    {info(item)}
    <Btn label="编辑" small onPress={() => edit(item)} />
  </View>;
  const ownRows = rows.filter((item) => own.has(item.key));
  const sharedRows = rows.filter((item) => !own.has(item.key));
  return <>
    <HeaderButton label={`提示词 ${rows.length || ""}`.trim()} onPress={() => { setView({ page: "list" }); setError(null); setOpen(true); }} testID="injected-prompts" />
    <Modal title={`${label} · 注入的提示词`} open={open} onOpenChange={setOpen}>
      <Modal.Content contentContainerStyle={{ padding: 16, gap: 10 }}>
        {view.page === "list" ? <>
          {query.isLoading ? <Muted>正在读取…</Muted> : null}
          {ownRows.length ? <Muted>角色提示词</Muted> : null}
          {ownRows.map(row)}
          {sharedRows.length ? <Muted>其它注入（交接、上下文、tab 交流）</Muted> : null}
          {sharedRows.map(row)}
        </> : current ? <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Btn label="返回" small onPress={() => setView({ page: "list" })} />
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{current.title}</Text>
            {view.page === "edit" ? info(current) : null}
          </View>
          {view.page === "edit" ? <>
            <TextField multiline value={draft} onChangeText={setDraft} style={{ minHeight: 360, maxHeight: 520 }} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}><Btn label="保存提示词" variant="primary" disabled={saving}
                onPress={() => void run(() => save({ key: current.key, text: draft, projectId: null }), () => setView({ page: "list" }))} /></View>
              {current.globalOverride ? <Btn label="恢复默认" disabled={saving}
                onPress={() => void run(() => clear({ key: current.key, projectId: null }), () => setView({ page: "list" }))} /> : null}
            </View>
          </> : <View style={{ gap: 8 }}>
            {current.description ? <Muted>{current.description}</Muted> : null}
            {current.whenSent ? <Muted>{`发送时机：${current.whenSent}`}</Muted> : null}
            {current.audience ? <Muted>{`接收者：${current.audience}`}</Muted> : null}
            {current.placeholders.length ? <Muted>{`占位符：${current.placeholders.map((item) => `{{${item.name}}} ${item.description}`).join("；")}`}</Muted> : null}
            {current.fixedSuffix ? <Muted>{`固定规则（程序追加，不可改）：${current.fixedSuffix}`}</Muted> : null}
            <Muted>同一提示词全局共享；项目级覆盖请到「Agent 行为」页。</Muted>
          </View>}
        </> : <Muted>无法读取提示词。</Muted>}
        {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      </Modal.Content>
    </Modal>
  </>;
}

/** Same list, opened from a task tab's role. */
export function RolePromptButton({ role, label }: { role: TaskTabRole; label: string }) {
  return <InjectedPromptsButton target={{ tabRole: role }} label={label} />;
}
