import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardScreen } from "./client/board/BoardScreen";
import { BoardSettingsScreen, BoardSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  // `params`: { project?: <id|prefix>, card?: <key> } open a project tab / a card detail directly.
  client.addScreen({
    id: "board",
    title: (params) => (params.card ? `Vibe Board · ${params.card}` : "Vibe Board"),
    Component: BoardScreen,
  });

  client.addSidebarHeaderItem({
    id: "board",
    title: "Vibe Board",
    Component: BoardSidebarItem,
  });

  client.addSettingsScreen({
    id: "preferences",
    title: "Vibe Board",
    icon: "KanbanSquare",
    Component: BoardSettingsScreen,
  });

  client.addSlashCommand({
    name: "board",
    description: "Open the Vibe Board, or a card (e.g. /board WEB-12)",
    argumentHint: "[CARD-KEY]",
    context: "workspace",
    onSubmit({ args, openScreen }) {
      const card = args.trim().toUpperCase();
      openScreen({ screenId: "board", ...(card ? { params: { card } } : {}) });
    },
  });

  client.addCommandCenterItem({
    id: "open-board",
    title: "Vibe Board: Open",
    icon: "KanbanSquare",
    keywords: ["board", "kanban", "cards", "tasks", "vibe"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "board" });
    },
  });
}
