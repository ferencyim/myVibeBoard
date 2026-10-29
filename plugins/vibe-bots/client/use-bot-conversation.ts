import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { botsOpenRpc, botsStateRpc } from "../shared/rpc";

export function useBotConversation(id: string, openAgent: (id: string) => void) {
  const open = useRpc(botsOpenRpc);
  const read = useRpc(botsStateRpc);
  const client = useQueryClient();
  const request = useMemo(() => ({ id, active: true, pending: false, navigate: false }), [id]);
  const queryKey = useMemo(() => ["vibe-bots", "state", id], [id]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request.active = true;
    return () => { request.active = false; request.navigate = false; };
  }, [request]);
  const state = useQuery({ queryKey, queryFn: () => read({ id }), staleTime: 15_000, refetchInterval: (query) => query.state.data?.status === "creating" ? 1_000 : 15_000 });
  useEffect(() => {
    if (!request.active || !request.navigate) return;
    if (state.data?.status === "ready" && state.data.agentId) {
      request.navigate = false;
      openAgent(state.data.agentId);
    } else if (state.data?.status === "failed") request.navigate = false;
  }, [request, state.data, openAgent]);
  const run = useCallback(async () => {
    if (!request.active || request.pending) return;
    request.pending = true;
    setOpening(true);
    setError(null);
    try {
      await client.cancelQueries({ queryKey });
      if (!request.active) return;
      const result = await open({ id });
      if (!request.active) return;
      request.navigate = result.status === "creating";
      client.setQueryData(queryKey, result);
      if (result.status === "ready" && result.agentId) openAgent(result.agentId);
    } catch {
      if (request.active) setError("暂时无法打开 bot，请重试。");
    } finally {
      request.pending = false;
      if (request.active) setOpening(false);
    }
  }, [request, client, queryKey, open, id, openAgent]);
  const failure = error ?? state.data?.error;
  const creating = state.data?.status === "creating";
  let label = "打开主对话";
  if (failure) label = "重试打开主对话";
  if (opening) label = "正在打开…";
  if (creating) label = "正在创建…";
  return { open: run, disabled: opening || creating, error: failure, label };
}
