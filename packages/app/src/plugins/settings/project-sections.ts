import type { InstalledPlugin } from "../types";

/** Only the selected project's host contributes sections. Stable sort preserves registration order. */
export function collectProjectSettingsSections<
  Plugin extends Pick<InstalledPlugin, "serverId" | "id" | "projectSettingsSections">,
>(plugins: Plugin[], serverId: string) {
  return plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) => plugin.projectSettingsSections.map((section) => ({ plugin, section })))
    .sort((left, right) => (left.section.order ?? 0) - (right.section.order ?? 0));
}
