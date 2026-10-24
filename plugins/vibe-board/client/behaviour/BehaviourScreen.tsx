// "Agent 行为": every prompt any agent receives, grouped by role, editable globally or per project.
// The list comes from the shared prompt registry, so prompts registered by other plugins (verify,
// context, switch-provider, ...) show up here without a change to this page.

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as rpc from "../../shared/rpc";
import { PromptGroup } from "../vibe/prompts/prompt-editor";
import { useRpc } from "@getpaseo/plugin/client";
import { errorMessage } from "../common/logic";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Muted } from "../common/ui";
import { AUTOMATION_LINKS, MAINTAIN_LINK, groupByRole, type BehaviourPrompt } from "./logic";

/** Host navigation to other plugins' pages (a fork addition; absent on older hosts). */
interface CrossNav {
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
        任务规划、执行、探路和接续等提示词在这里编辑；总 agent 设置和提示词集中在总 agent 面板。
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
        <Muted>自动维护的规则提示词按规则分别配置，不在本页：</Muted>
        {nav?.openPluginScreen ? (
          <View style={{ flexDirection: "row" }}>
            <Btn
              small
              label="打开自动维护页"
              onPress={link(MAINTAIN_LINK.pluginId, MAINTAIN_LINK.screenId, false)}
            />
          </View>
        ) : (
          <Muted>（侧栏 → 自动维护）</Muted>
        )}
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
