import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc, type PluginProjectSidebarItemProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectAgentOpenRpc, projectAgentStateRpc } from "../shared/project-agent";
import {
  createProjectAgentRequest,
  deactivateProjectAgentRequest,
  openProjectAgentRequest,
  projectAgentPollInterval,
  projectAgentPresentation,
  receiveProjectAgentState,
} from "./project-agent-sidebar";

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
  const request = useMemo(() => createProjectAgentRequest(projectId), [projectId]);
  useEffect(() => {
    request.active = true;
    setOpening(false);
    setOpenError(null);
    return () => {
      deactivateProjectAgentRequest(request);
    };
  }, [request]);
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
    refetchInterval: (query) => projectAgentPollInterval(query.state.data),
    staleTime: 15_000,
  });
  useEffect(() => {
    receiveProjectAgentState(request, state.data, openAgent);
  }, [state.data, request, openAgent]);
  const open = useCallback(
    () => openProjectAgentRequest(request, {
      cancelQueries: () => queryClient.cancelQueries({
        queryKey: ["vibe-board", "project-agent", projectId],
      }),
      open: (id) => openProjectAgent({ projectId: id }),
      setState: (result) => queryClient.setQueryData(
        ["vibe-board", "project-agent", projectId], result,
      ),
      setOpening,
      setError: setOpenError,
      openAgent,
    }),
    [request, projectId, openProjectAgent, openAgent, queryClient],
  );
  const { label, error, disabled } = projectAgentPresentation(state.data, opening, openError);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        style={styles.row}
        onPress={open}
      >
        <Text style={styles.label}>{label}</Text>
        {error ? <Text style={styles.error}>异常</Text> : null}
      </Pressable>
      {error ? <Text style={styles.detail}>{error}</Text> : null}
    </View>
  );
}
