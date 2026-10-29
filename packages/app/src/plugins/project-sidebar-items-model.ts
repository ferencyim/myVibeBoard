export function collectProjectSidebarItems<
  Plugin extends {
    id: string;
    serverId: string;
    projectSidebarItems?: { id: string; order?: number }[];
  },
>(
  plugins: Plugin[],
  hosts: readonly { serverId: string; projectId: string }[],
  preferredServerId?: string | null,
) {
  const preferredHost = hosts.find((host) => host.serverId === preferredServerId);
  // An explicitly selected project host owns the row even while disconnected.
  const selectedHosts = preferredHost ? [preferredHost] : hosts;
  const seen = new Set<string>();
  const rows: {
    plugin: Plugin;
    item: NonNullable<Plugin["projectSidebarItems"]>[number];
    projectId: string;
  }[] = [];
  for (const host of selectedHosts) {
    for (const plugin of plugins) {
      if (plugin.serverId !== host.serverId) continue;
      for (const item of plugin.projectSidebarItems ?? []) {
        const key = `${plugin.id}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          plugin,
          item: item as NonNullable<Plugin["projectSidebarItems"]>[number],
          projectId: host.projectId,
        });
      }
    }
  }
  return rows.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
}
