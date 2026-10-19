import { getLocalReplica } from "../store/registry";
import type { LocalReplica } from "../store/replica";
import {
  OfflineRpcError,
  VIBE_BOARD_PLUGIN_ID,
  createLocalVibeRpc,
  type LocalVibeRpc,
} from "./local-rpc";

const rpcs = new WeakMap<LocalReplica, LocalVibeRpc>();

/** Offline answer for a plugin RPC: vibe-board's board RPCs come from the local replica. */
export function invokeOfflineVibeRpc(
  serverId: string,
  pluginId: string,
  method: string,
  input: unknown,
): Promise<unknown> {
  const replica = pluginId === VIBE_BOARD_PLUGIN_ID ? getLocalReplica(serverId) : null;
  if (!replica) return Promise.reject(new OfflineRpcError(method));
  let rpc = rpcs.get(replica);
  if (!rpc) rpcs.set(replica, (rpc = createLocalVibeRpc(replica)));
  return rpc.invoke(method, input);
}
