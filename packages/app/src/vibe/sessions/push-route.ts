// Where a tap on a Vibe Board push goes. The daemon's board pushes carry only {event, cardKey}
// (minimal payload, no host id): card.verifying opens that card on the board, session.waiting opens
// the session overview where the waiting session is pinned on top.

import { VIBE_BOARD_PLUGIN_ID } from "../rpc/local-rpc";
import { buildPluginSurfaceRoute } from "@/plugins/routes";

type PushData = Record<string, unknown> | null | undefined;

const str = (data: PushData, key: string): string | null => {
  const v = data?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/**
 * `candidateServerIds`: hosts that have the board installed (first one wins when the push names
 * no host and several qualify). Returns null for pushes that are not Vibe Board events.
 */
export function resolveVibePushRoute(data: PushData, candidateServerIds: readonly string[]) {
  const event = str(data, "event");
  if (event !== "card.verifying" && event !== "session.waiting") return null;
  const serverId = str(data, "serverId") ?? candidateServerIds[0];
  if (!serverId) return null;
  const cardKey = str(data, "cardKey");
  if (event === "card.verifying") {
    return buildPluginSurfaceRoute(
      serverId,
      VIBE_BOARD_PLUGIN_ID,
      { kind: "surface", id: "board" },
      cardKey ? { card: cardKey } : {},
    );
  }
  return buildPluginSurfaceRoute(serverId, VIBE_BOARD_PLUGIN_ID, {
    kind: "surface",
    id: "sessions",
  });
}
