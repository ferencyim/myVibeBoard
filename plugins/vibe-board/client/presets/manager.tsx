// Project management.

import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import {
  PROJECT_TYPES,
  type Project,
} from "../../shared/vibe/contract";
import { errorMessage, projectColor } from "../common/logic";
import { type BoardApi } from "../common/api";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Dot, Field, Muted, TextField } from "../common/ui";
import {
  PROJECT_TYPE_LABELS,
  emptyProjectDraft,
  projectDraftToPayload,
  projectToDraft,
  toggleProjectType,
  validateProjectDraft,
  type ProjectDraft,
  type ProviderUsageLike,
} from "./logic";

import { RequirementsPanel } from "./requirements";

export const COLOR_CHOICES = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

export interface ManageProps {
  open: boolean;
  onClose: () => void;
  api: BoardApi;
  projects: readonly Project[];
  usage: readonly ProviderUsageLike[] | null;
  refresh: () => void;
}

export function ManageModal(props: ManageProps) {
  const host = useHost(); // Modal content renders in a host portal: bridge the host value.
  const { theme } = host;
  return (
    <Modal title="管理项目" open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <Modal.Content>
        <HostProvider value={host}>
          <View style={{ gap: 14 }}>
            <ProjectsTab {...props} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              数据保存在本机 vibe.db，所有端共享。
            </Text>
          </View>
        </HostProvider>
      </Modal.Content>
    </Modal>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>;
}

/** Shared by "新建项目" and the per-project edit mode. Module-level so typing never remounts inputs. */
function ProjectForm({
  mode,
  draft,
  onChange,
}: {
  mode: "create" | "edit";
  draft: ProjectDraft;
  onChange: (patch: Partial<ProjectDraft>) => void;
}) {
  const { openTaskDefaults } = useHost();
  return (
    <View style={{ gap: 10 }}>
      <Field label="名称">
        <TextField
          value={draft.name}
          onChangeText={(name) => onChange({ name })}
          placeholder="例如 官网"
        />
      </Field>
      <Field
        label={
          mode === "create" ? "前缀（大写字母数字，如 WEB，项目标识）" : "前缀（创建后不可修改）"
        }
      >
        {mode === "create" ? (
          <TextField
            value={draft.prefix}
            onChangeText={(prefix) => onChange({ prefix })}
            autoCapitalize="characters"
            placeholder="WEB"
          />
        ) : (
          <Text style={{ fontWeight: "600" }}>{draft.prefix}</Text>
        )}
      </Field>
      <Field label="仓库路径">
        <TextField
          value={draft.repoPath}
          onChangeText={(repoPath) => onChange({ repoPath })}
          placeholder="D:\repo\my-app"
          autoCapitalize="none"
        />
      </Field>
      <Field label="类型（可多选，至少一个；第一个为主类型）">
        <Row>
          {PROJECT_TYPES.map((t) => (
            <Chip
              key={t}
              label={PROJECT_TYPE_LABELS[t]}
              selected={draft.projectTypes.includes(t)}
              onPress={() => onChange({ projectTypes: toggleProjectType(draft.projectTypes, t) })}
            />
          ))}
        </Row>
      </Field>
      <Field label="简介（目标、技术栈等，会作为上下文交给 agent）">
        <TextField
          multiline
          value={draft.description}
          onChangeText={(description) => onChange({ description })}
        />
      </Field>
      <Field label="需求文档路径（相对仓库根目录）">
        <TextField
          value={draft.requirementsPath}
          onChangeText={(requirementsPath) => onChange({ requirementsPath })}
          autoCapitalize="none"
        />
      </Field>
      {openTaskDefaults ? <Btn label="打开任务角色设置" onPress={openTaskDefaults} /> : null}
      <Field label="并发上限（留空不限）">
        <TextField
          value={draft.concurrencyLimit}
          onChangeText={(concurrencyLimit) => onChange({ concurrencyLimit })}
          keyboardType="number-pad"
        />
      </Field>
      <Field label="设备（逗号分隔，留空不限）">
        <TextField
          value={draft.devices}
          onChangeText={(devices) => onChange({ devices })}
          autoCapitalize="none"
        />
      </Field>
      <Field label="颜色">
        <Row>
          {COLOR_CHOICES.map((c) => (
            <Chip
              key={c}
              label=""
              color={c}
              selected={draft.color === c}
              onPress={() => onChange({ color: c })}
            />
          ))}
        </Row>
      </Field>
    </View>
  );
}

function ProjectsTab({ api, projects, refresh }: ManageProps) {
  const toast = useToast();
  const nextColor = (n: number) => COLOR_CHOICES[n % COLOR_CHOICES.length]!;
  const [createDraft, setCreateDraft] = useState<ProjectDraft>(() =>
    emptyProjectDraft(nextColor(projects.length)),
  );
  const [edit, setEdit] = useState<{ id: string; draft: ProjectDraft } | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const create = () => {
    const problem = validateProjectDraft(createDraft, "create");
    if (problem) return toast.error(problem);
    return run(async () => {
      await api.projectsCreate({
        ...projectDraftToPayload(createDraft),
        prefix: createDraft.prefix.trim().toUpperCase(),
      });
      setCreateDraft(emptyProjectDraft(nextColor(projects.length + 1)));
    });
  };

  const saveEdit = () => {
    if (!edit) return;
    const problem = validateProjectDraft(edit.draft, "edit");
    if (problem) return toast.error(problem);
    return run(async () => {
      await api.projectsUpdate({ project: edit.id, ...projectDraftToPayload(edit.draft) });
      setEdit(null);
    });
  };

  return (
    <View style={{ gap: 14 }}>
      {projects.map((p, i) =>
        edit?.id === p.id ? (
          <View key={p.id} style={{ gap: 10 }}>
            <Text style={{ fontWeight: "600" }}>编辑项目 · {p.prefix}</Text>
            <ProjectForm
              mode="edit"
              draft={edit.draft}
              onChange={(patch) =>
                setEdit((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))
              }
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn variant="primary" label="保存项目" onPress={saveEdit} />
              <Btn label="取消" onPress={() => setEdit(null)} />
            </View>
            <RequirementsPanel api={api} projectId={p.id} />
          </View>
        ) : (
          <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Dot color={projectColor(p, i)} size={12} />
            <View style={{ flex: 1 }}>
              <Text>
                <Text style={{ fontWeight: "600" }}>{p.name}</Text>
                <Text> · {p.prefix}</Text>
              </Text>
              <Muted>{p.projectTypes.map((t) => PROJECT_TYPE_LABELS[t]).join(" / ")}</Muted>
            </View>
            <Btn
              small
              label="编辑"
              onPress={() => setEdit({ id: p.id, draft: projectToDraft(p, nextColor(i)) })}
            />
            <Btn
              small
              variant="ghost"
              label="归档"
              onPress={() => run(() => api.projectsUpdate({ project: p.id, archived: true }))}
            />
          </View>
        ),
      )}
      {projects.length === 0 ? <Muted>还没有项目，先在下面创建一个。</Muted> : null}
      <View style={{ gap: 10 }}>
        <Text style={{ fontWeight: "600" }}>新建项目</Text>
        <ProjectForm
          mode="create"
          draft={createDraft}
          onChange={(patch) => setCreateDraft((d) => ({ ...d, ...patch }))}
        />
        <Btn
          variant="primary"
          label="创建项目"
          icon="Plus"
          disabled={!createDraft.name.trim() || !createDraft.prefix.trim()}
          onPress={create}
        />
      </View>
    </View>
  );
}

/** Palette swatches for a tag; the first (empty) one means "automatic" (derived from the tag id). */
