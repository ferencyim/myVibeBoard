// Subtasks of the plan (WP-106). Plan tab: read and edit them (fields, dependencies, model, add and
// remove). Execution tab: each subtask's status, model and a link to its sub-agent's full session.

import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { AgentSession, CardView, Preset, Subtask } from "../../shared/vibe/contract";
import { errorMessage } from "../board/logic";
import { useLocalStatus, type BoardApi } from "../common/api";
import { useHost } from "../common/ctx";
import { Btn, Chip, Field, Muted, TextField } from "../common/ui";
import { ModelPicker } from "./ModelPicker";
import {
  editError,
  newSubtask,
  patchSubtask,
  removeSubtask,
  splitList,
  subtaskRows,
  toggleDependency,
  type SubtaskRow,
} from "./subtask-logic";

function Box({ children, highlight }: { children: React.ReactNode; highlight?: string }) {
  const { theme } = useHost();
  return (
    <View
      style={{
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: highlight ?? theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

function Line({ label, text }: { label: string; text: string }) {
  const { theme } = useHost();
  if (!text.trim()) return null;
  return (
    <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{label}：</Text>
      {text}
    </Text>
  );
}

/** Plan tab: the subtasks, read-only until 编辑子任务; saving makes them the owner's version. */
export function SubtaskEditor({
  api,
  card,
  presets,
  reload,
}: {
  api: BoardApi;
  card: CardView;
  presets: readonly Preset[];
  reload: () => Promise<unknown>;
}) {
  const { theme } = useHost();
  const toast = useToast();
  const { offline } = useLocalStatus();
  const server = card.plan?.subtasks ?? [];
  const [draft, setDraft] = useState<Subtask[] | null>(null);
  const [saving, setSaving] = useState(false);
  const error = draft ? editError(draft) : null;
  const nameOf = (id: string | null) => (id ? (presets.find((p) => p.id === id)?.name ?? "（已删除的预设）") : "子代理默认模型");

  const save = async () => {
    if (!draft || error) return;
    setSaving(true);
    try {
      await api.planSubtasks({ card: card.id, subtasks: draft });
      setDraft(null);
      void reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const hint = card.plan?.subtasksEdited
    ? "你改过子任务：规划模型再改时会在方案对话里以建议提出，由你决定是否采纳。"
    : "规划模型把工作拆成子任务，执行时主代理按依赖安排子代理完成；可以直接修改、增删、指定模型。";

  if (!draft) {
    return (
      <Field label={`子任务（${server.length}）`} hint={hint}>
        {server.length === 0 ? <Muted size={13}>还没有子任务：制定方案时规划模型会拆分，也可以自己添加。</Muted> : null}
        {server.map((s) => (
          <Box key={s.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
                {s.id} · {s.title}
              </Text>
              <Chip label={nameOf(s.presetId)} />
              {s.dependsOn.length ? <Muted size={11}>依赖 {s.dependsOn.join(", ")}</Muted> : null}
            </View>
            <Line label="目标" text={s.goal} />
            <Line label="方法" text={s.method} />
            <Line label="注意事项" text={s.notes} />
            <Line label="验收标准" text={s.acceptance} />
            <Line label="涉及文件" text={s.files.join(", ")} />
          </Box>
        ))}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn small icon="Pencil" label="编辑子任务" disabled={offline} onPress={() => setDraft(server.map((s) => ({ ...s })))} />
          {offline ? <Muted size={11}>需在线才能修改子任务</Muted> : null}
        </View>
      </Field>
    );
  }

  const set = (id: string, patch: Partial<Subtask>) => setDraft((d) => (d ? patchSubtask(d, id, patch) : d));
  return (
    <Field label={`编辑子任务（${draft.length}）`} hint="涉及文件用逗号或换行分隔；有交集的子任务不会同时运行。">
      {draft.map((s) => (
        <Box key={s.id} highlight={theme.colors.accent}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{s.id}</Text>
            <View style={{ flex: 1 }}>
              <TextField value={s.title} placeholder="标题" onChangeText={(title) => set(s.id, { title })} />
            </View>
            <Btn small variant="ghost" icon="Trash2" label="删除" onPress={() => setDraft((d) => (d ? removeSubtask(d, s.id) : d))} />
          </View>
          <TextField multiline value={s.goal} placeholder="目标" onChangeText={(goal) => set(s.id, { goal })} />
          <TextField multiline value={s.method} placeholder="方法" onChangeText={(method) => set(s.id, { method })} />
          <TextField multiline value={s.notes} placeholder="注意事项" onChangeText={(notes) => set(s.id, { notes })} />
          <TextField multiline value={s.acceptance} placeholder="验收标准" onChangeText={(acceptance) => set(s.id, { acceptance })} />
          <FilesField value={s.files} onChange={(files) => set(s.id, { files })} />
          {draft.length > 1 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Muted size={11}>依赖：</Muted>
              {draft
                .filter((o) => o.id !== s.id)
                .map((o) => (
                  <Chip
                    key={o.id}
                    label={o.id}
                    selected={s.dependsOn.includes(o.id)}
                    onPress={() => setDraft((d) => (d ? toggleDependency(d, s.id, o.id) : d))}
                  />
                ))}
            </View>
          ) : null}
          <ModelPicker
            label="模型"
            presets={presets}
            value={s.presetId}
            noneLabel="子代理默认模型"
            onChange={(presetId) => set(s.id, { presetId })}
          />
        </Box>
      ))}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Btn small icon="Plus" label="添加子任务" onPress={() => setDraft((d) => (d ? [...d, newSubtask(d)] : d))} />
        <Btn small variant="primary" label="保存子任务" disabled={saving || !!error || offline} onPress={save} />
        <Btn small label="放弃修改" onPress={() => setDraft(null)} />
      </View>
    </Field>
  );
}

/** The files field keeps the raw text while typing; the list is parsed from it. */
function FilesField({ value, onChange }: { value: string[]; onChange: (files: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <TextField
      value={text}
      placeholder="涉及文件，如 src/feature/**, docs/a.md"
      onChangeText={(next) => {
        setText(next);
        onChange(splitList(next));
      }}
    />
  );
}

/** Execution tab: what each subtask's sub-agent is doing. */
export function SubtaskList({
  card,
  presets,
  sessions,
}: {
  card: CardView;
  presets: readonly Preset[];
  sessions: readonly AgentSession[];
}) {
  const rows = subtaskRows(card, presets, sessions);
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.status === "done").length;
  return (
    <Field label={`子任务（完成 ${done}/${rows.length}）`} hint="主代理按依赖启动子代理；改某个子任务的模型只影响之后启动的子代理。">
      {rows.map((row) => (
        <SubtaskRowView key={row.id} row={row} />
      ))}
    </Field>
  );
}

function SubtaskRowView({ row }: { row: SubtaskRow }) {
  const { theme, openAgent } = useHost();
  const [open, setOpen] = useState(false);
  const color =
    row.status === "done"
      ? theme.colors.statusSuccess
      : row.status === "failed"
        ? theme.colors.statusDanger
        : row.status === "waiting"
          ? theme.colors.statusWarning
          : row.status === "running"
            ? theme.colors.accent
            : theme.colors.border;
  return (
    <Box highlight={color}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
          {row.id} · {row.title}
        </Text>
        <Chip label={row.statusLabel} color={color} />
        <Muted size={11}>{row.model}</Muted>
        {row.attempts > 1 ? <Muted size={11}>第 {row.attempts} 次</Muted> : null}
        {row.dependsOn.length ? <Muted size={11}>依赖 {row.dependsOn.join(", ")}</Muted> : null}
      </View>
      {row.modelChanged ? <Muted size={11}>已改了模型：正在运行的子代理不受影响，之后启动时使用新模型。</Muted> : null}
      {row.note ? (
        <Text selectable numberOfLines={open ? undefined : 2} style={{ color: theme.colors.foreground, fontSize: 12 }}>
          {row.note}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {row.note.length > 80 ? <Btn small variant="ghost" label={open ? "收起" : "展开"} onPress={() => setOpen(!open)} /> : null}
        {row.agentId && openAgent ? (
          <Btn small variant="ghost" icon="ExternalLink" label="查看子代理会话" onPress={() => openAgent({ agentId: row.agentId! })} />
        ) : null}
      </View>
    </Box>
  );
}
