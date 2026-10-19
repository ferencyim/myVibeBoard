import type { PluginClientContext } from "@getpaseo/plugin/client";
import { permissionRpc, statusRpc, switchRpc } from "./shared/rpc";
import { MasterScreen, MasterSettingsScreen, MasterSidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Master", Component: MasterScreen });
  client.addSidebarHeaderItem({ id: "master", title: "Master", Component: MasterSidebarItem });
  client.addSettingsScreen({
    id: "preferences",
    title: "Master",
    icon: "Bot",
    Component: MasterSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-master",
    title: "Master: Open status and switch subscription",
    icon: "Bot",
    keywords: ["master", "agent", "subscription", "switch", "claude", "codex"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  client.addCommandCenterItem({
    id: "switch-claude",
    title: "Master: Switch to Claude Opus",
    icon: "Bot",
    keywords: ["master", "switch", "claude", "opus"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(switchRpc, { provider: "claude", reason: "command palette" });
    },
  });
  client.addCommandCenterItem({
    id: "switch-codex",
    title: "Master: Switch to Codex (highest reasoning)",
    icon: "Bot",
    keywords: ["master", "switch", "codex", "gpt"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(switchRpc, { provider: "codex", thinking: "max", reason: "command palette" });
    },
  });
  const permissionItems = [
    { id: "auto", title: "Master permissions: Auto (recommended)", mode: "auto" },
    { id: "ask", title: "Master permissions: Ask for everything", mode: "default" },
    { id: "settings", title: "Master permissions: Follow the settings default", mode: "settings" },
  ];
  for (const item of permissionItems) {
    client.addCommandCenterItem({
      id: `permission-${item.id}`,
      title: item.title,
      icon: "Bot",
      keywords: ["master", "permission", "approval", "mode", "auto"],
      context: "global",
      async onSelect({ rpc }) {
        await rpc(permissionRpc, { mode: item.mode });
      },
    });
  }
  client.addCommandCenterItem({
    id: "permission-full",
    title: "Master permissions: Full access (no approvals)",
    icon: "Bot",
    keywords: ["master", "permission", "bypass", "full access", "yolo"],
    context: "global",
    async onSelect({ rpc }) {
      // The id differs per provider: take whichever highest mode the master's provider lists.
      const status = await rpc(statusRpc, { includeProviders: false });
      const ids = status.permission?.options.map((o) => o.id) ?? [];
      const mode = ["bypassPermissions", "full-access"].find((id) => ids.includes(id));
      if (mode) await rpc(permissionRpc, { mode });
    },
  });
  return () => {};
}
