// Typed RPC callers and the shared polled queries of the board UI.

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
    boardSummary: useRpc(rpc.boardSummaryRpc),
    cardsList: useRpc(rpc.cardsListRpc),
    cardsGet: useRpc(rpc.cardsGetRpc),
    cardsCreate: useRpc(rpc.cardsCreateRpc),
    cardsUpdate: useRpc(rpc.cardsUpdateRpc),
    cardsMove: useRpc(rpc.cardsMoveRpc),
    cardsReorder: useRpc(rpc.cardsReorderRpc),
    cardsArchive: useRpc(rpc.cardsArchiveRpc),
    cardsDelete: useRpc(rpc.cardsDeleteRpc),
    cardsDispatch: useRpc(rpc.cardsDispatchRpc),
    cardsRequestReview: useRpc(rpc.cardsRequestReviewRpc),
    requirementsGet: useRpc(rpc.requirementsGetRpc),
    requirementsSave: useRpc(rpc.requirementsSaveRpc),
    eventsAdd: useRpc(rpc.eventsAddRpc),
    chatSend: useRpc(rpc.chatSendRpc),
    proposalsAccept: useRpc(rpc.proposalsAcceptRpc),
    proposalsReject: useRpc(rpc.proposalsRejectRpc),
    tagsList: useRpc(rpc.tagsListRpc),
    tagsCreate: useRpc(rpc.tagsCreateRpc),
    tagsDelete: useRpc(rpc.tagsDeleteRpc),
    presetsList: useRpc(rpc.presetsListRpc),
    presetsCreate: useRpc(rpc.presetsCreateRpc),
    presetsUpdate: useRpc(rpc.presetsUpdateRpc),
    presetsDelete: useRpc(rpc.presetsDeleteRpc),
    providersCatalog: useRpc(rpc.providersCatalogRpc),
    attachmentsUpload: useRpc(rpc.attachmentsUploadRpc),
    attachmentsDownload: useRpc(rpc.attachmentsDownloadRpc),
    attachmentsDelete: useRpc(rpc.attachmentsDeleteRpc),
    sessionsList: useRpc(rpc.sessionsListRpc),
    replySend: useRpc(rpc.replySendRpc),
    localStatus: useRpc(rpc.localStatusRpc),
    verifyGet: useRpc(rpc.verifyGetRpc),
    verifyList: useRpc(rpc.verifyListRpc),
    verifyEvidence: useRpc(rpc.verifyEvidenceRpc),
    verifyApprove: useRpc(rpc.verifyApproveRpc),
    verifyReject: useRpc(rpc.verifyRejectRpc),
    verifyRerun: useRpc(rpc.verifyRerunRpc),
  };
}

export type BoardApi = ReturnType<typeof useBoardApi>;

const ROOT = "vibe-board";

/** Polled board data. React Query's structural sharing keeps references (no re-render) while
 *  nothing changed, so a poll only refreshes the UI when the data actually differs. */
export function useBoardData(includeDone = true) {
  const api = useBoardApi();
  const cards = useQuery({
    queryKey: [ROOT, "cards"],
    queryFn: () => api.cardsList({ limit: 2000 }),
    refetchInterval: 3000,
  });
  const projects = useQuery({
    queryKey: [ROOT, "projects"],
    queryFn: () => api.projectsList({}),
    refetchInterval: 8000,
  });
  const tags = useQuery({
    queryKey: [ROOT, "tags"],
    queryFn: () => api.tagsList({}),
    refetchInterval: 15000,
  });
  const presets = useQuery({
    queryKey: [ROOT, "presets"],
    queryFn: () => api.presetsList({}),
    refetchInterval: 15000,
  });
  return {
    api,
    cards: (cards.data?.cards ?? []).filter((c) => includeDone || c.column !== "done"),
    projects: projects.data?.projects ?? [],
    tags: tags.data?.tags ?? [],
    presets: presets.data?.presets ?? [],
    loading: cards.isLoading || projects.isLoading,
    error: cards.error ?? projects.error ?? null,
  };
}

/** Refresh everything after a write. */
export function useRefresh() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: [ROOT] }), [client]);
}

export const queryKey = (...parts: unknown[]) => [ROOT, ...parts];

/** All sessions (polled); one shared query serves the overview screen and every card badge. */
export function useSessionsData() {
  const api = useBoardApi();
  const query = useQuery({
    queryKey: [ROOT, "sessions"],
    queryFn: () => api.sessionsList({}),
    refetchInterval: 3000,
  });
  return { sessions: query.data?.sessions ?? [], loading: query.isLoading, error: query.error ?? null };
}

/** Offline state: `asOf` for the read-only banner and the replies queued on the phone. */
export function useLocalStatus() {
  const api = useBoardApi();
  const query = useQuery({
    queryKey: [ROOT, "local-status"],
    queryFn: () => api.localStatus({}),
    refetchInterval: 3000,
  });
  return query.data ?? { offline: false, asOf: null, replies: [] };
}
