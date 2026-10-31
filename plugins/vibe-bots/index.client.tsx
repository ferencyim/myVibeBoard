import type { PluginClientContext } from "@getpaseo/plugin/client";
import { IndependentBotsSidebar } from "./client/sidebar";
import { ThreadTabs } from "./client/thread-tabs";
import { RoutinesScreen } from "./client/routines";
import { BotProfilePanel, BotProfileScreen } from "./client/profile";


export default function contribute(client: PluginClientContext) {
  client.addSidebarGroup({ id: "independent-bots", title: "bot", createLabel: "新建独立 bot", order: 0, Component: IndependentBotsSidebar });
  client.addConversationHeaderAccessory({ id: "threads", Component: ThreadTabs });
  client.addAgentPanel({ id: "profile", title: "资料", icon: "Bot", locations: ["explorer"], Component: BotProfilePanel });
  client.addScreen({ id: "routines", title: "例程", Component: RoutinesScreen });
  client.addScreen({ id: "profile", title: "bot 资料", Component: BotProfileScreen });
  return () => {};
}

