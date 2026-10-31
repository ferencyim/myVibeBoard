// "Agent 行为": every prompt any agent receives, grouped by role, editable globally or per project.
// The list comes from the shared prompt registry, so prompts registered by other plugins (verify,
// context, switch-provider, ...) show up here without a change to this page.

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as rpc from "../../shared/rpc";
import { PromptGroup } from "../vibe/prompts/prompt-editor";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { errorMessage } from "../common/logic";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Muted } from "../common/ui";
import { AUTOMATION_LINKS, MAINTENANCE_HINT, groupByRole, type BehaviourPrompt } from "./logic";

/** Host navigation to other plugins' pages (a fork addition; absent on older hosts). */
interface CrossNav {
  openAgent?: (input: { agentId: string }) => void;
  openPluginScreen?: (input: { pluginId: string; screenId: string }) => void;
  openPluginSettings?: (input: { pluginId: string; screenId: string }) => void;
}

export function BehaviourScreen(props: PluginScreenProps) {
  const nav = props.navigation as CrossNav | undefined;
  return (
    <HostProvider value={{ theme: props.theme, compact: props.layout.compact }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <BehaviourContent nav={nav} />
      </ScrollView>
    </HostProvider>
  );
}

function BehaviourSection({ children }: { children: React.ReactNode }) {
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

function BehaviourContent({ nav }: { nav?: CrossNav }) {
  const { theme } = useHost();
  const paseo = usePaseo();
  const coordinator = useQuery({
    queryKey: ["vibe-bots", "list", "coordinator"],
    queryFn: async () => {
      const result = await paseo.plugins.invoke("vibe-bots", "bots.list", { kind: "independent" });
      const bots = (result as { bots?: Array<{ role: string; mainAgentId: string | null }> }).bots ?? [];
      return bots.find((bot) => bot.role === "coordinator")?.mainAgentId ?? null;
    },
    enabled: !!nav?.openAgent,
    retry: false,
  });
  const list = useRpc(rpc.promptsListRpc);
  const set = useRpc(rpc.promptsSetRpc);
  const clear = useRpc(rpc.promptsClearRpc);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vibe-board", "prompts"] });
  const [projectId, setProjectId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["vibe-board", "prompts", projectId],
    queryFn: () => list({ projectId }),
  });
  const groups = groupByRole((query.data?.prompts ?? []) as BehaviourPrompt[]).filter(
    (g) => g.role !== "master",
  );
  const projects = query.data?.projects ?? [];
  const orphans = query.data?.orphans ?? [];
  const [orphanError, setOrphanError] = useState<string | null>(null);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const discardOrphan = async (key: string, owner: string | null) => {
    try {
      await clear({ key, projectId: owner });
      setOrphanError(null);
      await refresh();
    } catch (error) {
      setOrphanError(errorMessage(error));
    }
  };
  const link = (pluginId: string, screenId: string, settings: boolean) => () =>
    settings
      ? nav?.openPluginSettings?.({ pluginId, screenId })
      : nav?.openPluginScreen?.({ pluginId, screenId });

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>
        Agent 行为
      </Text>
      <Muted>
        这里只保留每个场景一条提示词：主会话、探路、方案复核、执行、子任务、复核、验证、tab
        交流说明、接手接续、上下文压缩/交接。总 agent 设置和提示词集中在总 agent 面板。
        按「默认 → 全局覆盖 → 项目覆盖」生效，项目覆盖优先。 占位符 {"{{name}}"}{" "}
        在发送时替换；灰色的「固定格式段」由程序追加，保证回复能被解析，不能修改。
      </Muted>

      <BehaviourSection>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>自动化设置入口</Text>
        {nav?.openPluginScreen ? (
          <Btn small label="打开总 agent 面板" onPress={link("vibe-master", "main", false)} />
        ) : (
          <Muted>总 agent 设置和提示词：侧栏 → 总 agent</Muted>
        )}
        {AUTOMATION_LINKS.map((l) => (
          <View
            key={l.pluginId}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}
          >
            <Muted>{l.label}</Muted>
            {nav?.openPluginSettings ? (
              <Btn small label="打开" onPress={link(l.pluginId, l.screenId, true)} />
            ) : (
              <Muted>（设置 → {l.pluginId}）</Muted>
            )}
          </View>
        ))}
        <Muted>{MAINTENANCE_HINT}，规则提示词按规则分别配置。</Muted>
        {nav?.openAgent && coordinator.data ? (
          <View style={{ flexDirection: "row" }}>
            <Btn small label="打开总协调 bot 会话" onPress={() => nav.openAgent?.({ agentId: coordinator.data! })} />
          </View>
        ) : null}
      </BehaviourSection>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <Muted>编辑范围：</Muted>
        <Chip label="全局" selected={projectId === null} onPress={() => setProjectId(null)} />
        {projects.map((p) => (
          <Chip
            key={p.id}
            label={p.name}
            selected={projectId === p.id}
            onPress={() => setProjectId(p.id)}
          />
        ))}
      </View>

      {orphans.length ? (
        <BehaviourSection>
          <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>
            旧覆盖已失效，请重新设置
          </Text>
          <Muted>
            以下提示词已被合并或删除，原来的覆盖不会再生效。请在上面的分组里重新设置；确认不再需要后可删除旧覆盖。
          </Muted>
          {orphans.map((orphan) => (
            <View
              key={`${orphan.key}@${orphan.projectId ?? "*"}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <Muted>
                {orphan.key} · {orphan.projectId ? projectName(orphan.projectId) : "全局"}
              </Muted>
              <Btn
                small
                label="删除旧覆盖"
                onPress={() => void discardOrphan(orphan.key, orphan.projectId)}
              />
            </View>
          ))}
          {orphanError ? (
            <Text style={{ color: theme.colors.statusDanger }}>{orphanError}</Text>
          ) : null}
        </BehaviourSection>
      ) : null}

      {query.isLoading ? <Muted>加载中...</Muted> : null}
      {query.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>{errorMessage(query.error)}</Text>
      ) : null}
      {groups.map((g) => (
        <PromptGroup
          key={g.role}
          label={g.label}
          prompts={g.prompts}
          projectId={projectId}
          projects={projects}
          theme={theme}
          save={async (input) => {
            await set(input);
            await refresh();
          }}
          clear={async (input) => {
            await clear(input);
            await refresh();
          }}
        />
      ))}
    </View>
  );
}
