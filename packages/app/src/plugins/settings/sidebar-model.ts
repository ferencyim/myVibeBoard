import type { InstalledPlugin } from "../types";

type SettingsPlugin = Pick<InstalledPlugin, "id" | "serverId" | "settingsScreens">;

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
