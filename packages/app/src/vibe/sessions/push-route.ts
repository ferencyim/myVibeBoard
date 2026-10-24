import { buildHostWorkspaceOpenRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

type PushData = Record<string, unknown> | null | undefined;

const str = (data: PushData, key: string): string | null => {
  const value = data?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** Legacy card notifications have no native task identity and cannot be mapped to a task. */
export function isRetiredVibePush(data: PushData): boolean {
  return Boolean(
    str(data, "cardKey") || str(data, "cardId") || str(data, "event")?.startsWith("card."),
  );
}

/** Route only the exact host and workspace named by the notification. */
export function resolveVibePushRoute(data: PushData) {
  if (isRetiredVibePush(data)) return null;
  const serverId = str(data, "serverId");
  const workspaceId = str(data, "workspaceId");
  if (!serverId || !workspaceId) return null;
  const agentId = str(data, "agentId");
  return agentId
    ? buildHostWorkspaceOpenRoute(serverId, workspaceId, `agent:${agentId}`)
    : buildHostWorkspaceRoute(serverId, workspaceId);
}
