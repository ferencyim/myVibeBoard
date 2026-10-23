import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export function invokeConnectedPluginRpc(
  client: Pick<DaemonClient, "invokePluginRpc"> | null,
  pluginId: string,
  method: string,
  input: unknown,
): Promise<unknown> {
  if (!client) {
    return Promise.reject(
      new Error("[offline] 主机未连接；设置、确认、审批和停止操作须联网后重试"),
    );
  }
  return client.invokePluginRpc(pluginId, method, input);
}
