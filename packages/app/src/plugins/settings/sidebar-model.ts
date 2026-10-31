import type { InstalledPlugin } from "../types";

type SettingsPlugin = Pick<InstalledPlugin, "id" | "serverId" | "settingsScreens">;

export function pluginSettingsFromPath(pathname: string) {
  const match = /^\/settings\/hosts\/([^/]+)\/plugins\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const [, serverId, pluginId, screenId] = match;
    return {
      serverId: decodeURIComponent(serverId),
      pluginId: decodeURIComponent(pluginId),
      screenId: decodeURIComponent(screenId),
    };
  } catch {
    return null;
  }
}

export function collectSettingsSidebarScreens<Plugin extends SettingsPlugin>(
  plugins: readonly Plugin[],
  serverId: string | null,
) {
  return plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) => plugin.settingsScreens.map((screen) => ({ plugin, screen })))
    .sort((left, right) => {
      const order = (left.screen.order ?? 0) - (right.screen.order ?? 0);
      return (
        order ||
        left.plugin.id.localeCompare(right.plugin.id) ||
        left.screen.id.localeCompare(right.screen.id)
      );
    });
}

export function settingsPluginCategory(pluginId: string): "task" | "automation" | "other" {
  if (["vibe-board", "vibe-bots", "vibe-master"].includes(pluginId)) return "task";
  if (["vibe-scheduler", "vibe-maintain"].includes(pluginId)) return "automation";
  return "other";
}

export function settingsSearchMatches(label: string, query: string): boolean {
  return label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
