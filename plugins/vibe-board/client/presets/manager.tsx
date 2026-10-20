// "管理" dialog: projects, presets (with live quota) and tags.

import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import {
  PRESET_ENVIRONMENT_KINDS,
  PRESET_PERMISSION_MODES,
  PROJECT_TYPES,
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
  ROLE_HINT_LABELS,
  draftToPayload,
  presetToDraft,
  toggleFallback,
  validateDraft,
  type PresetDraft,
  type ProviderUsageLike,
} from "./logic";
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

function ProjectsTab({ api, projects, presets, refresh }: ManageProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [color, setColor] = useState(COLOR_CHOICES[projects.length % COLOR_CHOICES.length]!);
  const [type, setType] = useState<(typeof PROJECT_TYPES)[number]>("other");
  const [defaultPresetId, setDefaultPresetId] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const create = () =>
    run(async () => {
      await api.projectsCreate({
        name,
        prefix: prefix.trim().toUpperCase(),
        repoPath,
        color,
        projectType: type,
        defaultPresetId,
      });
      setName("");
      setPrefix("");
      setRepoPath("");
      setColor(COLOR_CHOICES[(projects.length + 1) % COLOR_CHOICES.length]!);
    });

  return (
    <View style={{ gap: 14 }}>
      {projects.map((p, i) => (
        <View key={p.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Dot color={projectColor(p, i)} size={12} />
            <Text style={{ flex: 1 }}>
              <Text style={{ fontWeight: "600" }}>{p.name}</Text>
              <Text> · {p.prefix}</Text>
            </Text>
            <Btn small variant="ghost" label="归档" onPress={() => run(() => api.projectsUpdate({ project: p.id, archived: true }))} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {COLOR_CHOICES.map((c) => (
              <Chip
                key={c}
                label=""
                color={c}
                selected={p.color === c}
                onPress={() => run(() => api.projectsUpdate({ project: p.id, color: c }))}
              />
            ))}
          </View>
        </View>
      ))}
      {projects.length === 0 ? <Muted>还没有项目，先在下面创建一个。</Muted> : null}
      <View style={{ gap: 10 }}>
        <Text style={{ fontWeight: "600" }}>新建项目</Text>
        <Field label="名称">
          <TextField value={name} onChangeText={setName} placeholder="例如 官网" />
        </Field>
        <Field label="前缀（大写字母数字，如 WEB，用于卡片编号 WEB-1）">
          <TextField value={prefix} onChangeText={setPrefix} autoCapitalize="characters" placeholder="WEB" />
        </Field>
        <Field label="仓库路径">
          <TextField value={repoPath} onChangeText={setRepoPath} placeholder="D:\repo\my-app" autoCapitalize="none" />
        </Field>
        <Field label="类型">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {PROJECT_TYPES.map((t) => (
              <Chip key={t} label={t} selected={type === t} onPress={() => setType(t)} />
            ))}
          </View>
        </Field>
        <Field label="颜色">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {COLOR_CHOICES.map((c) => (
              <Chip key={c} label="" color={c} selected={color === c} onPress={() => setColor(c)} />
            ))}
          </View>
        </Field>
        <Field label="默认预设">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Chip label="无" selected={defaultPresetId === null} onPress={() => setDefaultPresetId(null)} />
            {presets.map((p) => (
              <Chip key={p.id} label={p.name} selected={defaultPresetId === p.id} onPress={() => setDefaultPresetId(p.id)} />
            ))}
          </View>
        </Field>
        <Btn variant="primary" label="创建项目" icon="Plus" disabled={!name.trim() || !prefix.trim()} onPress={create} />
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
                onPress={() => patch({ provider: p.id, model: "" })}
              />
            ))}
          </View>
          <TextField value={draft.provider} onChangeText={(provider) => patch({ provider })} autoCapitalize="none" />
        </Field>
        <Field label="模型（必填）">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {models.map((m) => (
              <Chip key={m.id} label={m.name} selected={draft.model === m.id} onPress={() => patch({ model: m.id })} />
            ))}
          </View>
          <TextField value={draft.model} onChangeText={(model) => patch({ model })} placeholder="必填：点选上方模型或手动输入" autoCapitalize="none" />
        </Field>
        <Field label="用途">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(ROLE_HINT_LABELS).map(([value, label]) => (
              <Chip key={value} label={label} selected={draft.roleHint === value} onPress={() => patch({ roleHint: value })} />
            ))}
          </View>
        </Field>
        <Field label="思考强度">
          <TextField value={draft.thinking} onChangeText={(thinking) => patch({ thinking })} placeholder="可留空" autoCapitalize="none" />
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
              {p.roleHint ? `  [${ROLE_HINT_LABELS[p.roleHint] ?? p.roleHint}]` : ""}
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
