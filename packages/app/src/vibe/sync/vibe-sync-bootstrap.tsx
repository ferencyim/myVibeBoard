import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useInstalledPlugin } from "@/plugins/registry";
import { VIBE_BOARD_PLUGIN_ID } from "../rpc/local-rpc";
import { getLocalReplica } from "../store/registry";
import { SYNC_INTERVAL_MS, createSyncEngine } from "./engine";

/** Keeps the host's local board replica in step: on connect, on foreground and every 10 s. */
export function VibeSyncBootstrap({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const connected = useHostRuntimeIsConnected(serverId);
  const hasBoard = useInstalledPlugin(serverId, VIBE_BOARD_PLUGIN_ID) !== null;

  useEffect(() => {
    const replica = connected && hasBoard ? getLocalReplica(serverId) : null;
    if (!replica) return;
    const engine = createSyncEngine({
      replica,
      invoke: (method, input) => client.invokePluginRpc(VIBE_BOARD_PLUGIN_ID, method, input),
    });
    const run = () => {
      if (AppState.currentState === "active") void engine.run();
    };
    run();
    const timer = setInterval(run, SYNC_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [client, connected, hasBoard, serverId]);

  return null;
}
