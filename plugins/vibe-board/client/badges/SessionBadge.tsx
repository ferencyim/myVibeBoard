// Status badge on a board card: the card's live session state (and the open question).

import React, { useMemo } from "react";
import { Text, View } from "react-native";
import { useSessionsData } from "../common/api";
import { useHost } from "../common/ctx";
import { badgesByCard, type CardBadge } from "./logic";

/** cardId -> badge, from the one shared sessions query. */
export function useCardBadges(): ReadonlyMap<string, CardBadge> {
  const { sessions } = useSessionsData();
  return useMemo(() => badgesByCard(sessions), [sessions]);
}

export function SessionBadge({ cardId }: { cardId: string }) {
  const { theme } = useHost();
  const badge = useCardBadges().get(cardId);
  if (!badge) return null;
  const color =
    badge.tone === "danger"
      ? theme.colors.statusDanger
      : badge.tone === "active"
        ? theme.colors.accent
        : theme.colors.foregroundMuted;
  return (
    <View
      accessibilityLabel={`会话状态：${badge.label}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{badge.label}</Text>
      {badge.detail ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 }} numberOfLines={1}>
          {badge.detail}
        </Text>
      ) : null}
    </View>
  );
}
