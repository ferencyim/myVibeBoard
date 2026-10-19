import type { PluginClientContext } from "@getpaseo/plugin/client";
import { switchRpc } from "./shared/rpc";
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
  return () => {};
}
