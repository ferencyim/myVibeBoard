// "管理" dialog: projects, presets (with live quota) and tags.

import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import {
  PRESET_ENVIRONMENT_KINDS,
  PRESET_PERMISSION_MODES,
  PROJECT_TYPES,
  ROLE_HINTS,
  type Preset,
  type Project,
  type Tag,
} from "../../shared/vibe/contract";
import { errorMessage, projectColor } from "../board/logic";
import { queryKey, type BoardApi } from "../common/api";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Check, Chip, Dot, Field, Muted, TextField } from "../common/ui";
import {
  ENVIRONMENT_LABELS,
  EMPTY_PRESET_DRAFT,
  PERMISSION_LABELS,
  PROJECT_TYPE_LABELS,
  ROLE_HINT_LABELS,
  draftToPayload,
  emptyProjectDraft,
  presetToDraft,
  projectDraftToPayload,
  projectToDraft,
  thinkingAfterModelChange,
  thinkingChoices,
  toggleFallback,
  toggleProjectType,
  toggleRoleHint,
  validateDraft,
  validateProjectDraft,
  type PresetDraft,
  type ProjectDraft,
  type ProviderUsageLike,
} from "./logic";
import { RequirementsPanel } from "./requirements";
import { QuotaBadge } from "./usage";

export const COLOR_CHOICES = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

type Tab = "projects" | "presets" | "tags";

export interface ManageProps {
  open: boolean;
  onClose: () => void;
  api: BoardApi;
  projects: readonly Project[];
  presets: readonly Preset[];
  tags: readonly Tag[];
  usage: readonly ProviderUsageLike[] | null;
  refresh: () => void;
  initialTab?: Tab;
}

export function ManageModal(props: ManageProps) {
  const host = useHost(); // Modal content renders in a host portal: bridge the host value.
  const { theme } = host;
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "projects");
  return (
    <Modal title="管理" open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <Modal.Content>
        <HostProvider value={host}>
        <View style={{ gap: 14 }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Chip label="项目" selected={tab === "projects"} onPress={() => setTab("projects")} />
            <Chip label="Agent 预设" selected={tab === "presets"} onPress={() => setTab("presets")} />
            <Chip label="标签" selected={tab === "tags"} onPress={() => setTab("tags")} />
          </View>
          {tab === "projects" ? <ProjectsTab {...props} /> : null}
          {tab === "presets" ? <PresetsTab {...props} /> : null}
          {tab === "tags" ? <TagsTab {...props} /> : null}
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
  presets,
}: {
  mode: "create" | "edit";
  draft: ProjectDraft;
  onChange: (patch: Partial<ProjectDraft>) => void;
  presets: readonly Preset[];
}) {
  return (
    <View style={{ gap: 10 }}>
      <Field label="名称">
        <TextField value={draft.name} onChangeText={(name) => onChange({ name })} placeholder="例如 官网" />
      </Field>
      <Field label={mode === "create" ? "前缀（大写字母数字，如 WEB，用于卡片编号 WEB-1）" : "前缀（创建后不可修改）"}>
        {mode === "create" ? (
          <TextField value={draft.prefix} onChangeText={(prefix) => onChange({ prefix })} autoCapitalize="characters" placeholder="WEB" />
        ) : (
          <Text style={{ fontWeight: "600" }}>{draft.prefix}</Text>
        )}
      </Field>
      <Field label="仓库路径">
        <TextField value={draft.repoPath} onChangeText={(repoPath) => onChange({ repoPath })} placeholder="D:\repo\my-app" autoCapitalize="none" />
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
        <TextField multiline value={draft.description} onChangeText={(description) => onChange({ description })} />
      </Field>
      <Field label="需求文档路径（相对仓库根目录）">
        <TextField value={draft.requirementsPath} onChangeText={(requirementsPath) => onChange({ requirementsPath })} autoCapitalize="none" />
      </Field>
      <Field label="默认预设">
        <Row>
          <Chip label="无" selected={draft.defaultPresetId === null} onPress={() => onChange({ defaultPresetId: null })} />
          {presets.map((p) => (
            <Chip key={p.id} label={p.name} selected={draft.defaultPresetId === p.id} onPress={() => onChange({ defaultPresetId: p.id })} />
          ))}
        </Row>
      </Field>
      <Field label="并发上限（留空不限）">
        <TextField value={draft.concurrencyLimit} onChangeText={(concurrencyLimit) => onChange({ concurrencyLimit })} keyboardType="number-pad" />
      </Field>
      <Field label="设备（逗号分隔，留空不限）">
        <TextField value={draft.devices} onChangeText={(devices) => onChange({ devices })} autoCapitalize="none" />
      </Field>
      <Field label="颜色">
        <Row>
          {COLOR_CHOICES.map((c) => (
            <Chip key={c} label="" color={c} selected={draft.color === c} onPress={() => onChange({ color: c })} />
          ))}
        </Row>
      </Field>
    </View>
  );
}

function ProjectsTab({ api, projects, presets, refresh }: ManageProps) {
  const toast = useToast();
  const nextColor = (n: number) => COLOR_CHOICES[n % COLOR_CHOICES.length]!;
  const [createDraft, setCreateDraft] = useState<ProjectDraft>(() => emptyProjectDraft(nextColor(projects.length)));
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
      await api.projectsCreate({ ...projectDraftToPayload(createDraft), prefix: createDraft.prefix.trim().toUpperCase() });
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
              presets={presets}
              onChange={(patch) => setEdit((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e))}
            />
            <RequirementsPanel api={api} projectId={p.id} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn variant="primary" label="保存" onPress={saveEdit} />
              <Btn label="取消" onPress={() => setEdit(null)} />
            </View>
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
            <Btn small label="编辑" onPress={() => setEdit({ id: p.id, draft: projectToDraft(p, nextColor(i)) })} />
            <Btn small variant="ghost" label="归档" onPress={() => run(() => api.projectsUpdate({ project: p.id, archived: true }))} />
          </View>
        ),
      )}
      {projects.length === 0 ? <Muted>还没有项目，先在下面创建一个。</Muted> : null}
      <View style={{ gap: 10 }}>
        <Text style={{ fontWeight: "600" }}>新建项目</Text>
        <ProjectForm mode="create" draft={createDraft} presets={presets} onChange={(patch) => setCreateDraft((d) => ({ ...d, ...patch }))} />
        <Btn variant="primary" label="创建项目" icon="Plus" disabled={!createDraft.name.trim() || !createDraft.prefix.trim()} onPress={create} />
      </View>
    </View>
  );
}

function PresetsTab({ api, presets, usage, refresh }: ManageProps) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<PresetDraft>(EMPTY_PRESET_DRAFT);
  const catalog = useQuery({
    queryKey: queryKey("providers-catalog"),
    queryFn: () => api.providersCatalog({}),
    staleTime: 60_000,
    retry: false,
  });
  const providers = catalog.data?.providers ?? [];
  const models = providers.find((p) => p.id === draft.provider)?.models ?? [];
  const patch = (p: Partial<PresetDraft>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    const problem = validateDraft(draft);
    if (problem) return toast.error(problem);
    try {
      if (editing === "new") await api.presetsCreate(draftToPayload(draft));
      else if (editing) await api.presetsUpdate({ presetId: editing, ...draftToPayload(draft) });
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (editing) {
    return (
      <View style={{ gap: 10 }}>
        <Field label="名称">
          <TextField value={draft.name} onChangeText={(name) => patch({ name })} />
        </Field>
        <Field label="Agent（provider）">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {providers.map((p) => (
              <Chip
                key={p.id}
                label={`${p.id}${p.available ? "" : "（不可用）"}`}
                selected={draft.provider === p.id}
                onPress={() => patch({ provider: p.id, model: "", thinking: "" })}
              />
            ))}
          </View>
          <TextField value={draft.provider} onChangeText={(provider) => patch({ provider })} autoCapitalize="none" />
        </Field>
        <Field label="模型（必填）">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {models.map((m) => (
              <Chip
                key={m.id}
                label={m.name}
                selected={draft.model === m.id}
                onPress={() => patch({ model: m.id, thinking: thinkingAfterModelChange(models, m.id, draft.thinking) })}
              />
            ))}
          </View>
          <TextField value={draft.model} onChangeText={(model) => patch({ model, thinking: thinkingAfterModelChange(models, model, draft.thinking) })} placeholder="必填：点选上方模型或手动输入" autoCapitalize="none" />
        </Field>
        <Field label="用途（可多选，都不选表示不指定）">
          <Row>
            {ROLE_HINTS.map((hint) => (
              <Chip
                key={hint}
                label={ROLE_HINT_LABELS[hint]}
                selected={draft.roleHints.includes(hint)}
                onPress={() => patch({ roleHints: toggleRoleHint(draft.roleHints, hint) })}
              />
            ))}
          </Row>
        </Field>
        <Field label="思考强度">
          <Row>
            {thinkingChoices(models, draft.model, draft.thinking).map((o) => (
              <Chip key={o.id || "default"} label={o.label} selected={draft.thinking === o.id} onPress={() => patch({ thinking: o.id })} />
            ))}
          </Row>
        </Field>
        <Field label="权限模式">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {PRESET_PERMISSION_MODES.map((m) => (
              <Chip key={m} label={PERMISSION_LABELS[m]} selected={draft.permissionMode === m} onPress={() => patch({ permissionMode: m })} />
            ))}
          </View>
        </Field>
        <Field label="运行环境">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {PRESET_ENVIRONMENT_KINDS.map((k) => (
              <Chip key={k} label={ENVIRONMENT_LABELS[k]} selected={draft.environmentKind === k} onPress={() => patch({ environmentKind: k })} />
            ))}
          </View>
        </Field>
        <Field label="基础分支">
          <TextField value={draft.baseBranch} onChangeText={(baseBranch) => patch({ baseBranch })} placeholder="main" autoCapitalize="none" />
        </Field>
        <Field label="运行时环境（如 android-emulator）">
          <TextField value={draft.runtimeEnv} onChangeText={(runtimeEnv) => patch({ runtimeEnv })} autoCapitalize="none" />
        </Field>
        <Field label="附加指令">
          <TextField multiline value={draft.instructions} onChangeText={(instructions) => patch({ instructions })} />
        </Field>
        <Field label="失败时改派到（按点选顺序依次尝试；额度耗尽、登录失效、agent 不可用时在同一 worktree 继续）">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {presets
              .filter((p) => p.id !== editing)
              .map((p) => {
                const order = draft.fallbackPresetIds.indexOf(p.id);
                return (
                  <Chip
                    key={p.id}
                    label={order >= 0 ? `${order + 1}. ${p.name}` : p.name}
                    selected={order >= 0}
                    onPress={() => patch({ fallbackPresetIds: toggleFallback(draft.fallbackPresetIds, p.id) })}
                  />
                );
              })}
          </View>
          {presets.length <= 1 ? <Muted>先创建其它预设，才能选作备选。</Muted> : null}
        </Field>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn variant="primary" label="保存" onPress={save} />
          <Btn label="取消" onPress={() => setEditing(null)} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {presets.map((p) => (
        <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "600" }}>{p.name}</Text>
            <Muted>
              {p.provider} / {p.model}
              {p.roleHints.length ? `  [${p.roleHints.map((h) => ROLE_HINT_LABELS[h]).join("/")}]` : ""}
              {p.fallbackPresetIds?.length
                ? `  →  ${p.fallbackPresetIds.map((id) => presets.find((x) => x.id === id)?.name ?? "?").join(" → ")}`
                : ""}
            </Muted>
          </View>
          <QuotaBadge provider={p.provider} usage={usage} />
          <Btn
            small
            label="编辑"
            onPress={() => {
              setDraft(presetToDraft(p));
              setEditing(p.id);
            }}
          />
          {!p.builtin ? (
            <Btn
              small
              variant="danger"
              icon="Trash2"
              onPress={async () => {
                try {
                  await api.presetsDelete({ presetId: p.id });
                  refresh();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            />
          ) : null}
        </View>
      ))}
      {presets.length === 0 ? <Muted>还没有预设。</Muted> : null}
      <Btn
        variant="primary"
        icon="Plus"
        label="新建预设"
        onPress={() => {
          setDraft(EMPTY_PRESET_DRAFT);
          setEditing("new");
        }}
      />
    </View>
  );
}

function TagsTab({ api, tags, refresh }: ManageProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [evidence, setEvidence] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <View style={{ gap: 10 }}>
      {tags.map((t) => (
        <View key={t.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1 }}>
            {t.name}
            {t.evidence ? "（默认需要验证证据）" : ""}
          </Text>
          {!t.builtin ? (
            <Btn small variant="danger" icon="Trash2" onPress={() => run(() => api.tagsDelete({ tagId: t.id }))} />
          ) : null}
        </View>
      ))}
      <Field label="新标签">
        <TextField value={name} onChangeText={setName} />
      </Field>
      <Check label="默认需要验证证据" value={evidence} onChange={setEvidence} />
      <Btn
        variant="primary"
        icon="Plus"
        label="添加标签"
        disabled={!name.trim()}
        onPress={() =>
          run(async () => {
            await api.tagsCreate({ name, evidence });
            setName("");
          })
        }
      />
    </View>
  );
}
