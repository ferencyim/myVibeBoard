import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { queryClient as singletonQueryClient } from "@/data/query-client";
import {
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  fetchProvidersSnapshot,
  refreshAndApplyProvidersSnapshot,
} from "@/data/providers-snapshot";

import { providerSnapshotCache, type CachedProviderSnapshot } from "@/data/provider-snapshot-cache";

export {
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  fetchProvidersSnapshot,
  refreshAndApplyProvidersSnapshot,
};

export type ProvidersSnapshotClient = Pick<
  DaemonClient,
  "getProvidersSnapshot" | "refreshProvidersSnapshot"
>;

export type SelectorOpenRefetchDecision = "refetch-stale" | "refetch-always";

export function selectorOpenRefetchDecision(input: {
  entries: ProviderSnapshotEntry[] | undefined;
  selectedProvider: AgentProvider | null | undefined;
}): SelectorOpenRefetchDecision {
  if (!input.selectedProvider) {
    return "refetch-stale";
  }
  const selectedEntry = input.entries?.find((entry) => entry.provider === input.selectedProvider);
  if (!selectedEntry || selectedEntry.status === "loading") {
    return "refetch-always";
  }
  return "refetch-stale";
}

interface UseProvidersSnapshotResult {
  entries: ProviderSnapshotEntry[] | undefined;
  lastSyncedAt?: string;
  isLoading: boolean;
  isFetching: boolean;
  isRefreshing: boolean;
  error: string | null;
  supportsSnapshot: boolean;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
  refetchIfStale: (selectedProvider?: AgentProvider | null) => void;
}

interface UseProvidersSnapshotOptions {
  enabled?: boolean;
  cwd?: string | null;
}

function useOfflineProviderSnapshot(
  serverId: string | null,
  cwd: string | null,
  isConnected: boolean,
) {
  const [offlineSnapshot, setOfflineSnapshot] = useState<{
    serverId: string;
    cwd: string | null;
    snapshot: CachedProviderSnapshot | null;
  } | null>(null);
  useEffect(() => {
    if (!serverId || isConnected) return;
    let active = true;
    void (async () => {
      const snapshot =
        (await providerSnapshotCache.read(serverId, cwd)) ??
        (await providerSnapshotCache.readLatest(serverId));
      if (active) setOfflineSnapshot({ serverId, cwd, snapshot });
    })();
    return () => {
      active = false;
    };
  }, [serverId, cwd, isConnected]);
  return offlineSnapshot && offlineSnapshot.serverId === serverId && offlineSnapshot.cwd === cwd
    ? offlineSnapshot.snapshot
    : null;
}

function providerSnapshotData(
  live: { entries: ProviderSnapshotEntry[]; generatedAt: string } | undefined,
  cached: CachedProviderSnapshot | null,
) {
  return {
    entries: live?.entries ?? cached?.entries,
    lastSyncedAt: cached?.syncedAt ?? live?.generatedAt ?? cached?.generatedAt,
  };
}

export function useProvidersSnapshot(
  serverId: string | null,
  options: UseProvidersSnapshotOptions = {},
): UseProvidersSnapshotResult {
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const enabled = (options.enabled ?? true) && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const supportsSnapshot = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providersSnapshot === true,
  );

  const queryKey = useMemo(() => providersSnapshotQueryKey(serverId, cwd), [cwd, serverId]);

  const snapshotQuery = useReplicaQuery({
    queryKey,
    // The content-hash cache already owns catalog and model identity.
    structuralSharing: false,
    enabled: Boolean(enabled && supportsSnapshot && serverId && client && isConnected),
    pushEvent: "providers_snapshot_update",
    queryFn: async ({ signal }) => {
      if (!client || !serverId) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return fetchProvidersSnapshot({ client, serverId, cwd, queryClient, signal });
    },
  });

  const cached = useOfflineProviderSnapshot(serverId, cwd, isConnected);

  const refreshMutation = useMutation({
    mutationFn: async (providers?: AgentProvider[]) => {
      if (!client || !serverId) {
        return;
      }
      await refreshAndApplyProvidersSnapshot({
        client,
        queryClient,
        serverId,
        cwd,
        providers,
      });
    },
  });
  const { mutateAsync: refreshSnapshot, isPending: isRefreshing } = refreshMutation;

  const refresh = useCallback(
    async (providers?: AgentProvider[]) => {
      await refreshSnapshot(providers);
    },
    [refreshSnapshot],
  );

  const refetchIfStale = useCallback(
    (selectedProvider?: AgentProvider | null) => {
      const decision = selectorOpenRefetchDecision({
        entries: snapshotQuery.data?.entries,
        selectedProvider,
      });
      if (decision === "refetch-always") {
        void queryClient.refetchQueries({ queryKey, type: "active" });
        return;
      }
      void queryClient.refetchQueries({ queryKey, type: "active", stale: true });
    },
    [queryClient, queryKey, snapshotQuery.data?.entries],
  );

  return {
    ...providerSnapshotData(snapshotQuery.data, cached),
    isLoading: snapshotQuery.isLoading,
    isFetching: snapshotQuery.isFetching,
    isRefreshing,
    error: snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null,
    supportsSnapshot,
    refresh,
    refetchIfStale,
  };
}

export function prefetchProvidersSnapshot(
  serverId: string,
  client: DaemonClient,
  options: { cwd?: string | null } = {},
): void {
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const queryKey = providersSnapshotQueryKey(serverId, cwd);
  void singletonQueryClient.prefetchQuery({
    queryKey,
    staleTime: Infinity,
    structuralSharing: false,
    queryFn: ({ signal }) =>
      fetchProvidersSnapshot({ client, serverId, cwd, queryClient: singletonQueryClient, signal }),
  });
}
