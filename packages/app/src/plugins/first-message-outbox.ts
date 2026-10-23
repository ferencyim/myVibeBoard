import type { InstalledPlugin } from "./types";

/** Snapshot the installed owner with the intent so reconnects cannot change its destination. */
export function resolveFirstMessageOutboxOwner(
  plugins: readonly Pick<InstalledPlugin, "serverId" | "id" | "firstMessageOutboxOwners">[],
  serverId: string,
): { pluginId: string; initialRole: string } | undefined {
  const owners = plugins.filter(
    (plugin) => plugin.serverId === serverId && (plugin.firstMessageOutboxOwners?.length ?? 0) > 0,
  );
  if (owners.length > 1) throw new Error("多个插件声明接收新会话首消息，请仅启用一个后重试");
  const owner = owners[0];
  return owner
    ? { pluginId: owner.id, initialRole: owner.firstMessageOutboxOwners![0].initialRole }
    : undefined;
}
