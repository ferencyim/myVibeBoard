import { useMemo } from "react";
import { useDaemonConfig } from "./use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { buildModelGroupProvider } from "@/provider-selection/provider-selection";

export function useModelGroupProvider(serverId: string | null) {
  const { config } = useDaemonConfig(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.modelGroups === true,
  );
  return useMemo(
    () => (supported ? buildModelGroupProvider(config?.modelGroups ?? []) : undefined),
    [supported, config?.modelGroups],
  );
}
