import type { InstalledPlugin } from "@/plugins/types";

export function collectSidebarGroups(plugins: InstalledPlugin[], hostFilters: readonly string[]) {
  return plugins
    .flatMap((plugin) =>
      hostFilters.length > 0 && !hostFilters.includes(plugin.serverId)
        ? []
        : (plugin.sidebarGroups ?? []).map((item) => ({ plugin, item })),
    )
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
}
