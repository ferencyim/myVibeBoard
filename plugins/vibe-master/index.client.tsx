import type { PluginClientContext } from "@getpaseo/plugin/client";
import { permissionRpc, statusRpc } from "./shared/rpc";
import {
  MasterScreen,
  MasterSettingsScreen,
  MasterSidebarItem,
  PromptLibrarySidebarItem,
} from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "总 agent", Component: MasterScreen });
  client.addSidebarHeaderItem({
    id: "master",
    title: "总 agent",
    order: -30,
    Component: MasterSidebarItem,
  });
  client.addSidebarHeaderItem({
    id: "prompt-library",
    title: "提示词仓库",
    order: -20,
    Component: PromptLibrarySidebarItem,
  });
  client.addSettingsScreen({
    order: -30,
    id: "preferences",
    title: "总 agent",
    icon: "Bot",
    Component: MasterSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-master",
    title: "总 agent：查看状态",
    icon: "Bot",
    keywords: ["master", "agent", "preset", "dispatch"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
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
      const status = await rpc(statusRpc, {});
      const ids = status.permission?.options.map((o) => o.id) ?? [];
      const mode = ["bypassPermissions", "full-access"].find((id) => ids.includes(id));
      if (mode) await rpc(permissionRpc, { mode });
    },
  });
  return () => {};
}
