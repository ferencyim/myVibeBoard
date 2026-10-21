// "Agent 行为": every prompt any agent receives, grouped by role, editable globally or per project.
// The list comes from the shared prompt registry, so prompts registered by other plugins (verify,
// context, switch-provider, ...) show up here without a change to this page.

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as rpc from "../../shared/rpc";
import { useRpc } from "@getpaseo/plugin/client";
import { errorMessage } from "../board/logic";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Muted, TextField } from "../common/ui";
import {
  AUTOMATION_LINKS,
  MAINTAIN_LINK,
  SOURCE_LABELS,
  editorText,
  groupByRole,
  ownOverride,
  sourceIn,
  textToSave,
  unknownIn,
  type BehaviourPrompt,
} from "./logic";

/** Host navigation to other plugins' pages (a fork addition; absent on older hosts). */
interface CrossNav {
  openPluginScreen?: (input: { pluginId: string; screenId: string }) => void;
  openPluginSettings?: (input: { pluginId: string; screenId: string }) => void;
}

export function BehaviourScreen(props: PluginScreenProps) {
  const nav = props.navigation as CrossNav | undefined;
  return (
    <HostProvider value={{ theme: props.theme, compact: props.layout.compact }}>
      <BehaviourContent nav={nav} />
    </HostProvider>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  const { theme } = useHost();
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      {children}
    </View>
  );
}

function BehaviourContent({ nav }: { nav: CrossNav | undefined }) {
  const { theme } = useHost();
  const list = useRpc(rpc.promptsListRpc);
  const [projectId, setProjectId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["vibe-board", "prompts", projectId],
    queryFn: () => list({ projectId }),
  });
  const groups = groupByRole((query.data?.prompts ?? []) as BehaviourPrompt[]);
  const projects = query.data?.projects ?? [];
  const link = (pluginId: string, screenId: string, settings: boolean) => () =>
    settings ? nav?.openPluginSettings?.({ pluginId, screenId }) : nav?.openPluginScreen?.({ pluginId, screenId });

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>Agent 行为</Text>
      <Muted>
        所有 agent 收到的提示词都在这里：总 agent 的系统规则、规划会话、执行 agent 的派发说明、探路兵、交接、看门狗等。按「默认 → 全局覆盖 → 项目覆盖」生效，项目覆盖优先。
        占位符 {"{{name}}"} 在发送时替换；灰色的「固定格式段」由程序追加，保证回复能被解析，不能修改。
      </Muted>

      <Card>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>自动化设置入口</Text>
        {AUTOMATION_LINKS.map((l) => (
          <View key={l.pluginId} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Muted>{l.label}</Muted>
            {nav?.openPluginSettings ? (
              <Btn small label="打开" onPress={link(l.pluginId, l.screenId, true)} />
            ) : (
              <Muted>（设置 → {l.pluginId}）</Muted>
            )}
          </View>
        ))}
        <Muted>自动维护的规则提示词按规则分别配置，不在本页：</Muted>
        {nav?.openPluginScreen ? (
          <View style={{ flexDirection: "row" }}>
            <Btn small label="打开自动维护页" onPress={link(MAINTAIN_LINK.pluginId, MAINTAIN_LINK.screenId, false)} />
          </View>
        ) : (
          <Muted>（侧栏 → 自动维护）</Muted>
        )}
      </Card>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <Muted>编辑范围：</Muted>
        <Chip label="全局" selected={projectId === null} onPress={() => setProjectId(null)} />
        {projects.map((p) => (
          <Chip key={p.id} label={p.name} selected={projectId === p.id} onPress={() => setProjectId(p.id)} />
        ))}
      </View>

      {query.isLoading ? <Muted>加载中...</Muted> : null}
      {query.error ? <Text style={{ color: theme.colors.statusDanger }}>{errorMessage(query.error)}</Text> : null}
      {groups.map((g) => (
        <RoleGroup key={g.role} label={g.label} prompts={g.prompts} projectId={projectId} projects={projects} />
      ))}
    </ScrollView>
  );
}

function RoleGroup({
  label,
  prompts,
  projectId,
  projects,
}: {
  label: string;
  prompts: BehaviourPrompt[];
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
}) {
  const { theme } = useHost();
  const [open, setOpen] = useState(false);
  const changed = prompts.filter((p) => p.globalOverride !== null || p.overriddenProjects.length > 0).length;
  return (
    <View style={{ gap: 8 }}>
      <Btn
        variant="ghost"
        label={`${open ? "▾" : "▸"} ${label}（${prompts.length}${changed ? `，已自定义 ${changed}` : ""}）`}
        onPress={() => setOpen(!open)}
      />
      {open ? prompts.map((p) => <PromptEditor key={p.key} prompt={p} projectId={projectId} projects={projects} />) : null}
      {open ? null : <View style={{ height: 1, backgroundColor: theme.colors.border }} />}
    </View>
  );
}

function PromptEditor({
  prompt,
  projectId,
  projects,
}: {
  prompt: BehaviourPrompt;
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
}) {
  const { theme } = useHost();
  const toast = useToast();
  const queryClient = useQueryClient();
  const set = useRpc(rpc.promptsSetRpc);
  const clear = useRpc(rpc.promptsClearRpc);
  const [open, setOpen] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const shown = editorText(prompt, projectId);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown, projectId]);
  const dirty = draft !== shown;
  const source = sourceIn(prompt, projectId);
  const unknown = unknownIn(prompt, draft);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vibe-board", "prompts"] });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.show(errorMessage(e), { variant: "error" });
    }
  };
  const names = prompt.overriddenProjects
    .map((id) => projects.find((p) => p.id === id)?.name)
    .filter((n): n is string => !!n);

  return (
    <Card>
      <Btn
        variant="ghost"
        label={`${open ? "▾" : "▸"} ${prompt.title} · ${SOURCE_LABELS[source]}`}
        onPress={() => setOpen(!open)}
      />
      <Muted>{prompt.description}</Muted>
      {open ? (
        <View style={{ gap: 8 }}>
          <Muted>何时发送：{prompt.whenSent || "—"}</Muted>
          <Muted>发给：{prompt.audience || "—"}</Muted>
          <Muted>
            当前生效来源：{SOURCE_LABELS[source]}
            {names.length ? `；有项目覆盖：${names.join("、")}` : ""}
            {projectId && ownOverride(prompt, projectId) === null ? "（本项目没有自己的覆盖，沿用上一级）" : ""}
          </Muted>
          {prompt.placeholders.length ? (
            <Muted>可用占位符：{prompt.placeholders.map((p) => `{{${p.name}}} ${p.description}`).join("；")}</Muted>
          ) : (
            <Muted>此项不使用占位符，文本原样发送。</Muted>
          )}
          <TextField
            multiline
            value={draft}
            onChangeText={setDraft}
            style={{ minHeight: prompt.defaultText.length > 400 ? 260 : 120 }}
          />
          {unknown.length ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              未知占位符会被替换为空：{unknown.map((n) => `{{${n}}}`).join("、")}
            </Text>
          ) : null}
          {prompt.fixedSuffix ? (
            <View style={{ gap: 4 }}>
              <Muted>固定格式段（自动追加在正文之后，只读）：</Muted>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>
                {prompt.fixedSuffix}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Btn
              variant="primary"
              label={projectId ? "保存为项目覆盖" : "保存为全局覆盖"}
              disabled={!dirty}
              onPress={() =>
                void run(() => set({ key: prompt.key, text: textToSave(prompt, projectId, draft), projectId }))
              }
            />
            <Btn
              label="恢复默认"
              disabled={ownOverride(prompt, projectId) === null && !dirty}
              onPress={() => void run(() => clear({ key: prompt.key, projectId }))}
            />
            <Btn label={showDefault ? "隐藏默认全文" : "查看默认全文"} onPress={() => setShowDefault(!showDefault)} />
          </View>
          {showDefault ? (
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {prompt.defaultText || "（默认为空）"}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
