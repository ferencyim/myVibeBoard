import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotsScreen } from "./client/screen";
import { BotProfilePanel, BotProfileScreen } from "./client/profile";

const emptyParams = {};

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "bot 资料与记忆", Component: BotsScreen });
  client.addAgentPanel({ id: "profile", title: "bot 资料", icon: "Bot", locations: ["explorer"], Component: BotProfilePanel });
  client.addScreen({ id: "profile", title: "bot 资料", Component: BotProfileScreen });
  client.addSettingsScreen({ id: "bots", title: "bot 资料与记忆", icon: "Bot", Component: (props) => <BotsScreen {...props} params={emptyParams} /> });
  return () => {};
}
