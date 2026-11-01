import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { promptsListRpc, promptsSetRpc } from "../shared/rpc";
import type { TaskTabRole } from "../shared/vibe/contract";
import { useHost } from "./common/ctx";
import { Btn, Muted, TextField } from "./common/ui";

const ROLE_PROMPTS: Partial<Record<TaskTabRole, string>> = {
  main: "task.role.main",
  planner: "task.role.planner",
  scout: "task.role.scout",
  plan_reviewer: "task.role.plan_reviewer",
  worker: "board.task.work",
  reviewer: "verify.reviewer_system",
  verifier: "verify.verifier_system",
};

/** Edits the same global prompt used when this role is injected. */
export function RolePromptButton({ role, label }: { role: TaskTabRole; label: string }) {
  const { theme } = useHost();
  const list = useRpc(promptsListRpc);
  const save = useRpc(promptsSetRpc);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = ROLE_PROMPTS[role];
  const query = useQuery({
    queryKey: ["vibe-board", "prompts", null],
    queryFn: () => list({ projectId: null }),
    enabled: open && !!key,
  });
  const prompt = query.data?.prompts.find((item) => item.key === key);
  useEffect(() => { if (prompt) setDraft(prompt.globalOverride ?? prompt.defaultText); }, [prompt]);
  if (!key) return null;
  const show = () => { setDraft(prompt?.globalOverride ?? prompt?.defaultText ?? ""); setError(null); setOpen(true); };
  const submit = async () => {
    setSaving(true);
    try {
      await save({ key, text: draft, projectId: null });
      await queryClient.invalidateQueries({ queryKey: ["vibe-board", "prompts"] });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  return <>
    <Btn label="角色提示词" small onPress={show} testID={`role-prompt-${role}`} />
    <Modal title={`${label} · 角色提示词`} open={open} onOpenChange={setOpen}>
      <Modal.Content>
        <View style={{ gap: 10 }}>
          <Muted>同角色全局共享；新建或接手会话时注入。</Muted>
          {query.isLoading ? <Muted>正在读取…</Muted> : prompt ? <>
            <TextField multiline value={draft} onChangeText={setDraft} />
            {prompt.fixedSuffix ? <Muted>{`固定规则：${prompt.fixedSuffix}`}</Muted> : null}
            <Btn label="保存提示词" variant="primary" disabled={saving} onPress={() => void submit()} />
          </> : <Muted>无法读取角色提示词。</Muted>}
          {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
        </View>
      </Modal.Content>
    </Modal>
  </>;
}
