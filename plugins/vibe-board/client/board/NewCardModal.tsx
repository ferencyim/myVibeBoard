import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { CardPriority, Preset, Project, Tag } from "../../shared/vibe/contract";
import type { BoardApi } from "../common/api";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Check, Chip, Dot, Field, TextField } from "../common/ui";
import type { ProviderUsageLike } from "../presets/logic";
import { PresetSelector, PrioritySelector, TagSelector } from "../presets/selectors";
import { ReviewerSelect } from "./ReviewerSelect";
import { COLUMN_LABELS, errorMessage, evidenceDefault, projectColor } from "./logic";

export function NewCardModal({
  open,
  onClose,
  api,
  projects,
  tags,
  presets,
  usage,
  initialProjectId,
  initialColumn,
  refresh,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  api: BoardApi;
  projects: readonly Project[];
  tags: readonly Tag[];
  presets: readonly Preset[];
  usage: readonly ProviderUsageLike[] | null;
  initialProjectId: string | null;
  initialColumn: "draft" | "todo";
  refresh: () => void;
  onCreated?: (key: string) => void;
}) {
  const toast = useToast();
  // Modal content renders in a host portal, outside our context tree: bridge the host value.
  const host = useHost();
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [column, setColumn] = useState<"draft" | "todo">(initialColumn);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [priority, setPriority] = useState<CardPriority>("none");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [needsEvidence, setNeedsEvidence] = useState(false);
  const [evidenceTouched, setEvidenceTouched] = useState(false);
  // undefined = not picked here: the card starts from the project / global default models (WP-108).
  const [presetId, setPresetId] = useState<string | null | undefined>(undefined);
  const [reviewerPresetId, setReviewerPresetId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setProjectId(initialProjectId ?? projects[0]?.id ?? null);
      setColumn(initialColumn);
    }
  }, [open, initialProjectId, initialColumn, projects]);

  // Feature / change tags switch evidence on by default until the user decides otherwise.
  useEffect(() => {
    if (!evidenceTouched) setNeedsEvidence(evidenceDefault(tagIds, tags));
  }, [tagIds, tags, evidenceTouched]);

  const reset = () => {
    setTitle("");
    setDescription("");
    setAcceptance("");
    setPriority("none");
    setTagIds([]);
    setNeedsEvidence(false);
    setEvidenceTouched(false);
    setPresetId(undefined);
    setReviewerPresetId(undefined);
  };

  const submit = async () => {
    if (!projectId || !title.trim()) return;
    setBusy(true);
    try {
      const { card } = await api.cardsCreate({
        project: projectId,
        title: title.trim(),
        description,
        acceptance,
        column,
        priority,
        tagIds,
        needsEvidence,
        ...(presetId !== undefined ? { presetId } : {}),
        ...(reviewerPresetId !== undefined ? { reviewerPresetId } : {}),
      });
      reset();
      refresh();
      onClose();
      onCreated?.(card.key);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建卡片" open={open} onOpenChange={(o) => !o && onClose()}>
      <Modal.Content>
        <HostProvider value={host}>
        <View style={{ gap: 14 }}>
          <Field label="项目">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {projects.map((p, i) => (
                <Chip key={p.id} label={p.name} color={projectColor(p, i)} selected={projectId === p.id} onPress={() => setProjectId(p.id)} />
              ))}
            </View>
          </Field>
          <Field label="标题">
            <TextField value={title} onChangeText={setTitle} placeholder="要做什么？" autoFocus />
          </Field>
          <Field label="放入">
            <View style={{ flexDirection: "row", gap: 6 }}>
              {(["draft", "todo"] as const).map((c) => (
                <Chip key={c} label={COLUMN_LABELS[c]} selected={column === c} onPress={() => setColumn(c)} />
              ))}
            </View>
            {column === "todo" ? (
              <Text style={{ fontSize: 11, opacity: 0.7 }}>放入待办后会被派发给 agent 执行。</Text>
            ) : null}
          </Field>
          <Field label="描述">
            <TextField multiline value={description} onChangeText={setDescription} />
          </Field>
          <Field label="验收标准">
            <TextField multiline value={acceptance} onChangeText={setAcceptance} />
          </Field>
          <Field label="优先级">
            <PrioritySelector value={priority} onChange={setPriority} />
          </Field>
          <Field label="标签">
            <TagSelector tags={tags} value={tagIds} onChange={setTagIds} api={api} onTagsChanged={refresh} />
          </Field>
          <Check
            label="需要验证证据（截图/录屏）"
            value={needsEvidence}
            onChange={(v) => {
              setEvidenceTouched(true);
              setNeedsEvidence(v);
            }}
          />
          <Text style={{ fontSize: 11, opacity: 0.7 }}>
            各项模型不选时按项目、全局的默认模型预填，创建后可在卡片的各个页签里改。
          </Text>
          <Field label="执行主代理模型">
            <PresetSelector presets={presets} value={presetId ?? null} usage={usage} onChange={setPresetId} />
          </Field>
          <Field label="复核模型" hint="任务完成后由该模型 review 代码改动；发现严重问题会自动退回。">
            <ReviewerSelect presets={presets} value={reviewerPresetId ?? null} onChange={setReviewerPresetId} />
          </Field>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn variant="primary" label="创建" disabled={busy || !title.trim() || !projectId} onPress={submit} />
            <Btn label="取消" onPress={onClose} />
            {projectId ? <Dot color={projectColor(projects.find((p) => p.id === projectId) ?? { color: null }, 0)} /> : null}
          </View>
        </View>
      </HostProvider>
      </Modal.Content>
    </Modal>
  );
}
