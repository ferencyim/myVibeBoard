import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import * as rpc from "../../shared/rpc";
export function useBoardApi() {
  return {
    projectsList: useRpc(rpc.projectsListRpc),
    projectsCreate: useRpc(rpc.projectsCreateRpc),
    projectsUpdate: useRpc(rpc.projectsUpdateRpc),
    paseoProjectsList: useRpc(rpc.paseoProjectsListRpc),
    defaultsGet: useRpc(rpc.defaultsGetRpc),
    defaultsSet: useRpc(rpc.defaultsSetRpc),
    requirementsGet: useRpc(rpc.requirementsGetRpc),
    requirementsSave: useRpc(rpc.requirementsSaveRpc),
    presetsList: useRpc(rpc.presetsListRpc),
    presetsCreate: useRpc(rpc.presetsCreateRpc),
    presetsUpdate: useRpc(rpc.presetsUpdateRpc),
    presetsDelete: useRpc(rpc.presetsDeleteRpc),
    providersCatalog: useRpc(rpc.providersCatalogRpc),
  };
}

export type BoardApi = ReturnType<typeof useBoardApi>;
const ROOT = "vibe-board";
export function useRefresh() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: [ROOT] }), [client]);
}

export const queryKey = (...parts: unknown[]) => [ROOT, ...parts];

export function useGlobalDefaults() {
  const api = useBoardApi();
  const query = useQuery({
    queryKey: [ROOT, "defaults"],
    queryFn: () => api.defaultsGet({}),
    refetchInterval: 15000,
    retry: false,
  });
  return query.data?.global ?? {};
}
