import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotsScreen } from "./client/screen";
import { RoutinesScreen } from "./client/routines";
import { BotProfileScreen } from "./client/profile";

const emptyParams = {};

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "bot 资料与记忆", Component: BotsScreen });
  client.addScreen({ id: "routines", title: "例程", Component: RoutinesScreen });
  client.addScreen({ id: "profile", title: "bot 资料", Component: BotProfileScreen });
  client.addSettingsScreen({ id: "bots", title: "bot 资料与记忆", icon: "Bot", Component: (props) => <BotsScreen {...props} params={emptyParams} /> });
  return () => {};
}

