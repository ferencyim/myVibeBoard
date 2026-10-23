import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { promptsListRpc, promptsSetRpc, promptsClearRpc } from "../shared/rpc";
import { PromptGroup } from "./vibe/prompts/prompt-editor";
import { formatRpcError } from "../shared/vibe/ui/rpc-error";

export function MasterPrompts({ theme }: PluginSurfaceProps) {
  const list = useRpc(promptsListRpc);
  const save = useRpc(promptsSetRpc);
  const clear = useRpc(promptsClearRpc);
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["vibe-master", "prompts", projectId],
    queryFn: () => list({ projectId }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vibe-master", "prompts"] });
  const projects = query.data?.projects ?? [];
  const prompts = (query.data?.prompts ?? []).filter((p) => p.role === "master");
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        总 agent 的提示词按「默认 → 全局覆盖 → 项目覆盖」生效。固定格式段由程序追加，不可修改。
      </Text>
      <SettingsSelect
        label="编辑范围"
        value={projectId ?? ""}
        options={[
          { label: "全局", value: "" },
          ...projects.map((p) => ({ label: p.name, value: p.id })),
        ]}
        onValueChange={(id) => setProjectId(id || null)}
      />
      {query.isLoading ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>加载中...</Text>
      ) : null}
      {query.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>{formatRpcError(query.error)}</Text>
      ) : null}
      <PromptGroup
        label="总 agent 提示词与规则"
        prompts={prompts}
        projectId={projectId}
        projects={projects}
        theme={theme}
        save={async (input) => {
          await save(input);
          await refresh();
        }}
        clear={async (input) => {
          await clear(input);
          await refresh();
        }}
      />
    </View>
  );
}
