import React, { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc, type PluginProjectSidebarItemProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectAgentOpenRpc, projectAgentStateRpc } from "../shared/project-agent";

export function ProjectAgentSidebarItem({
  projectId,
  theme,
  openAgent,
}: PluginProjectSidebarItemProps) {
  const openProjectAgent = useRpc(projectAgentOpenRpc);
  const readProjectAgent = useRpc(projectAgentStateRpc);
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { paddingHorizontal: 24, paddingVertical: 8, flexDirection: "row", gap: 8 },
        label: { color: theme.colors.foreground },
        error: { color: theme.colors.statusDanger },
        detail: { color: theme.colors.statusDanger, paddingHorizontal: 24 },
      }),
    [theme],
  );
  const state = useQuery({
    queryKey: ["vibe-board", "project-agent", projectId],
    queryFn: () => readProjectAgent({ projectId }),
    refetchInterval: 15_000,
    staleTime: 15_000,
  });
  const open = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await openProjectAgent({ projectId });
      queryClient.setQueryData(["vibe-board", "project-agent", projectId], result);
      if (result.agentId) openAgent(result.agentId);
      if (result.error) setOpenError(result.error);
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
    }
  }, [opening, projectId, openProjectAgent, openAgent, queryClient]);
  const error = openError ?? state.data?.error;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={error ? "项目 agent，环境异常" : "项目 agent"}
        disabled={opening}
        style={styles.row}
        onPress={open}
      >
        <Text style={styles.label}>{opening ? "正在打开项目 agent…" : "项目 agent"}</Text>
        {error ? <Text style={styles.error}>异常</Text> : null}
      </Pressable>
      {openError ? <Text style={styles.detail}>{openError}</Text> : null}
    </View>
  );
}
