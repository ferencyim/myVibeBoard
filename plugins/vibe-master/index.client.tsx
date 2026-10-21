import type { PluginClientContext } from "@getpaseo/plugin/client";
import { permissionRpc, statusRpc, switchRpc } from "./shared/rpc";
import { MasterScreen, MasterSettingsScreen, MasterSidebarItem } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "总 agent", Component: MasterScreen });
  client.addSidebarHeaderItem({ id: "master", title: "总 agent", Component: MasterSidebarItem });
  client.addSettingsScreen({
    id: "preferences",
    title: "总 agent",
    icon: "Bot",
    Component: MasterSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-master",
    title: "总 agent：查看状态与切换订阅",
    icon: "Bot",
    keywords: ["master", "agent", "subscription", "switch", "claude", "codex"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  client.addCommandCenterItem({
    id: "switch-claude",
    title: "总 agent：切换到 Claude Opus",
    icon: "Bot",
    keywords: ["master", "switch", "claude", "opus"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(switchRpc, { provider: "claude", reason: "command palette" });
    },
  });
  client.addCommandCenterItem({
    id: "switch-codex",
    title: "总 agent：切换到 Codex（最高推理）",
    icon: "Bot",
    keywords: ["master", "switch", "codex", "gpt"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(switchRpc, { provider: "codex", thinking: "max", reason: "command palette" });
    },
  });
  const permissionItems = [
    { id: "auto", title: "总 agent 权限：自动（推荐）", mode: "auto" },
    { id: "ask", title: "总 agent 权限：每步都询问", mode: "default" },
    { id: "settings", title: "总 agent 权限：跟随设置默认值", mode: "settings" },
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
    title: "总 agent 权限：完全访问（不审批）",
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
