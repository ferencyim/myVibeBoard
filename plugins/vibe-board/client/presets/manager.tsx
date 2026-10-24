// Project extensions and ordered model presets.

import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  PRESET_ENVIRONMENT_KINDS,
  PRESET_PERMISSION_MODES,
  PROJECT_TYPES,
  presetModels,
  type ModelDefaults,
  type Preset,
  type Project,
} from "../../shared/vibe/contract";
import { errorMessage, projectColor } from "../common/logic";
import { queryKey, useGlobalDefaults, type BoardApi } from "../common/api";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Dot, Field, Muted, TextField } from "../common/ui";
import {
  ENVIRONMENT_LABELS,
  EMPTY_PRESET_DRAFT,
  EMPTY_MODEL_DRAFT,
  movePresetModel,
  PERMISSION_LABELS,
  PROJECT_TYPE_LABELS,
  draftToPayload,
  emptyProjectDraft,
  presetToDraft,
  projectDraftToPayload,
  projectToDraft,
  thinkingAfterModelChange,
  thinkingChoices,
  toggleProjectType,
  validateDraft,
  validateProjectDraft,
  type PresetDraft,
  type PresetModelDraft,
  type ProjectDraft,
  type ProviderUsageLike,
} from "./logic";
import { DefaultModelsEditor, GlobalDefaultsPanel } from "./defaults";
import { RequirementsPanel } from "./requirements";
import { QuotaBadge } from "./usage";

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

type Tab = "projects" | "presets";

export interface ManageProps {
  open: boolean;
  onClose: () => void;
  api: BoardApi;
  projects: readonly Project[];
  presets: readonly Preset[];
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
              <Chip
                label="Agent 预设"
                selected={tab === "presets"}
                onPress={() => setTab("presets")}
              />
            </View>
            {tab === "projects" ? <ProjectsTab {...props} /> : null}
            {tab === "presets" ? <PresetsTab {...props} /> : null}
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
  globalDefaults,
}: {
  mode: "create" | "edit";
  draft: ProjectDraft;
  onChange: (patch: Partial<ProjectDraft>) => void;
  presets: readonly Preset[];
  globalDefaults: ModelDefaults;
}) {
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
      <Field label="默认模型（覆盖全局；不选则沿用全局）">
        <DefaultModelsEditor
          value={draft.defaultPresets}
          presets={presets}
          inherited={globalDefaults}
          onChange={(defaultPresets) => onChange({ defaultPresets })}
        />
      </Field>
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

function ProjectsTab({ api, projects, presets, refresh }: ManageProps) {
  const toast = useToast();
  const nextColor = (n: number) => COLOR_CHOICES[n % COLOR_CHOICES.length]!;
  const [createDraft, setCreateDraft] = useState<ProjectDraft>(() =>
    emptyProjectDraft(nextColor(projects.length)),
  );
  const [edit, setEdit] = useState<{ id: string; draft: ProjectDraft } | null>(null);
  const globalDefaults = useGlobalDefaults();

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
              presets={presets}
              globalDefaults={globalDefaults}
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
          presets={presets}
          globalDefaults={globalDefaults}
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

function PresetModelEditor({
  value,
  providers,
  onChange: patch,
}: {
  value: PresetModelDraft;
  providers: Awaited<ReturnType<BoardApi["providersCatalog"]>>["providers"];
  onChange: (change: Partial<PresetModelDraft>) => void;
}) {
  const models = providers.find((p) => p.id === value.provider)?.models ?? [];
  return (
    <ScrollView
      horizontal
      contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <SettingsSelect
        inline
        label="Agent（provider）"
        value={value.provider}
        options={[
          ...(!value.provider ? [{ value: "", label: "请选择" }] : []),
          ...providers.map((p) => ({
            value: p.id,
            label: `${p.id}${p.available ? "" : "（不可用）"}`,
          })),
          ...(value.provider && !providers.some((p) => p.id === value.provider)
            ? [{ value: value.provider, label: `${value.provider}（已保存）` }]
            : []),
        ]}
        onValueChange={(provider) => {
          if (provider !== value.provider) patch({ provider, model: "", thinking: "" });
        }}
      />
      <SettingsSelect
        inline
        label="模型（必填）"
        value={value.model}
        options={[
          ...(!value.model ? [{ value: "", label: "请选择" }] : []),
          ...models.map((m) => ({ value: m.id, label: m.name })),
          ...(value.model && !models.some((m) => m.id === value.model)
            ? [{ value: value.model, label: `${value.model}（已保存）` }]
            : []),
        ]}
        onValueChange={(model) => {
          if (model !== value.model) {
            patch({ model, thinking: thinkingAfterModelChange(models, model, value.thinking) });
          }
        }}
      />
      <SettingsSelect
        inline
        label="思考强度"
        value={value.thinking}
        options={thinkingChoices(models, value.model, value.thinking).map((o) => ({
          value: o.id,
          label: o.label,
        }))}
        onValueChange={(thinking) => patch({ thinking })}
      />
      <SettingsSelect
        inline
        label="权限模式"
        value={value.permissionMode}
        options={PRESET_PERMISSION_MODES.map((m) => ({ value: m, label: PERMISSION_LABELS[m] }))}
        onValueChange={(permissionMode) => patch({ permissionMode })}
      />
    </ScrollView>
  );
}

function PresetsTab({ api, presets, usage, refresh }: ManageProps) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<PresetDraft>(EMPTY_PRESET_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const catalog = useQuery({
    queryKey: queryKey("providers-catalog"),
    queryFn: () => api.providersCatalog({}),
    staleTime: 60_000,
    retry: false,
  });
  const providers = catalog.data?.providers ?? [];
  const patch = (p: Partial<PresetDraft>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    const problem = validateDraft(draft);
    if (problem) return setSaveError(problem);
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (editing === "new") await api.presetsCreate(draftToPayload(draft));
      else if (editing) await api.presetsUpdate({ presetId: editing, ...draftToPayload(draft) });
      setEditing(null);
      refresh();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <View style={{ gap: 10 }}>
        <Field label="名称">
          <TextField value={draft.name} onChangeText={(name) => patch({ name })} />
        </Field>
        {catalog.isPending ? <Muted>正在加载 provider 和模型目录…</Muted> : null}
        {catalog.error ? <Muted>{errorMessage(catalog.error)}</Muted> : null}
        <Field label="候选模型（按顺序尝试，不可用时自动切换下一个）">
          {draft.models.map((candidate, index) => (
            <View key={index} style={{ gap: 8, paddingVertical: 8 }}>
              <Row>
                <Text style={{ fontWeight: "600" }}>候选 {index + 1}</Text>
                <Btn
                  small
                  label="上移"
                  disabled={index === 0}
                  onPress={() => patch({ models: movePresetModel(draft.models, index, -1) })}
                />
                <Btn
                  small
                  label="下移"
                  disabled={index === draft.models.length - 1}
                  onPress={() => patch({ models: movePresetModel(draft.models, index, 1) })}
                />
                <Btn
                  small
                  label="删除候选"
                  variant="danger"
                  disabled={draft.models.length === 1}
                  onPress={() => patch({ models: draft.models.filter((_, i) => i !== index) })}
                />
              </Row>
              <PresetModelEditor
                value={candidate}
                providers={providers}
                onChange={(change) =>
                  patch({
                    models: draft.models.map((m, i) => (i === index ? { ...m, ...change } : m)),
                  })
                }
              />
            </View>
          ))}
          <Btn
            label="添加候选模型"
            icon="Plus"
            onPress={() => patch({ models: [...draft.models, { ...EMPTY_MODEL_DRAFT }] })}
          />
        </Field>
        <Field label="运行环境">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {PRESET_ENVIRONMENT_KINDS.map((k) => (
              <Chip
                key={k}
                label={ENVIRONMENT_LABELS[k]}
                selected={draft.environmentKind === k}
                onPress={() => patch({ environmentKind: k })}
              />
            ))}
          </View>
        </Field>
        <Field label="基础分支">
          <TextField
            value={draft.baseBranch}
            onChangeText={(baseBranch) => patch({ baseBranch })}
            placeholder="main"
            autoCapitalize="none"
          />
        </Field>
        <Field label="运行时环境（如 android-emulator）">
          <TextField
            value={draft.runtimeEnv}
            onChangeText={(runtimeEnv) => patch({ runtimeEnv })}
            autoCapitalize="none"
          />
        </Field>
        <Field label="附加指令">
          <TextField
            multiline
            value={draft.instructions}
            onChangeText={(instructions) => patch({ instructions })}
          />
        </Field>
        {saveError ? <Muted>{saveError}</Muted> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn
            variant="primary"
            label={saving ? "正在保存…" : "保存"}
            disabled={saving}
            onPress={save}
          />
          <Btn label="取消" disabled={saving} onPress={() => setEditing(null)} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <GlobalDefaultsPanel api={api} presets={presets} />
      <Text style={{ fontWeight: "600", marginTop: 8 }}>预设列表</Text>
      {presets.map((p) => (
        <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "600" }}>{p.name}</Text>
            <Muted>
              {presetModels(p)
                .map((m) => `${m.provider} / ${m.model}`)
                .join(" → ")}
            </Muted>
          </View>
          <View style={{ gap: 4 }}>
            {[...new Set(presetModels(p).map((m) => m.provider))].map((provider) => (
              <QuotaBadge key={provider} provider={provider} usage={usage} />
            ))}
          </View>
          <Btn
            small
            label="编辑"
            onPress={() => {
              setSaveError(null);
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
          setSaveError(null);
          setDraft(EMPTY_PRESET_DRAFT);
          setEditing("new");
        }}
      />
    </View>
  );
}

/** Palette swatches for a tag; the first (empty) one means "automatic" (derived from the tag id). */
