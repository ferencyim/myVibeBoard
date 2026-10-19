import { Icon } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Pressable, Text, View } from "react-native";
import type { CardView, Preset, Tag } from "../../shared/vibe/contract";
import { useHost } from "../common/ctx";
import { SessionBadge } from "../badges/SessionBadge";
import { Muted } from "../common/ui";
import { PRIORITY_LABELS } from "./logic";

export function CardItem({
  card,
  color,
  projectName,
  tagsById,
  presetsById,
  onOpen,
  onMenu,
  handle,
}: {
  card: CardView;
  color: string;
  projectName?: string;
  tagsById: ReadonlyMap<string, Tag>;
  presetsById: ReadonlyMap<string, Preset>;
  onOpen: () => void;
  onMenu: () => void;
  /** Drag handle element (gesture area). */
  handle: React.ReactNode;
}) {
  const { theme } = useHost();
  const preset = presetsById.get(card.presetId ?? "") ?? presetsById.get(card.suggestedPresetId ?? "");
  const suggestedOnly = !card.presetId && !!card.suggestedPresetId;
  return (
    <View
      style={{
        flexDirection: "row",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
      }}
    >
      <View style={{ width: 4, backgroundColor: color }} />
      <Pressable accessibilityRole="button" onPress={onOpen} style={{ flex: 1, padding: 10, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{card.key}</Text>
          {projectName ? (
            <Text style={{ color, fontSize: 11 }} numberOfLines={1}>
              {projectName}
            </Text>
          ) : null}
          <View style={{ flex: 1 }} />
          {card.priority !== "none" ? (
            <Text
              style={{
                color:
                  card.priority === "urgent" || card.priority === "high"
                    ? theme.colors.statusDanger
                    : theme.colors.foregroundMuted,
                fontSize: 11,
              }}
            >
              {PRIORITY_LABELS[card.priority]}
            </Text>
          ) : null}
          {card.needsEvidence ? <Icon name="Camera" size={12} color={theme.colors.foregroundMuted} /> : null}
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={3}>
          {card.title}
        </Text>
        <SessionBadge cardId={card.id} />
        {card.tags.length > 0 || preset ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            {card.tags.map((id) => (
              <View
                key={id}
                style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: theme.colors.surface2 }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                  {tagsById.get(id)?.name ?? id}
                </Text>
              </View>
            ))}
            {preset ? (
              <Muted size={10}>
                {suggestedOnly ? "推荐 " : ""}
                {preset.name}
              </Muted>
            ) : null}
          </View>
        ) : null}
      </Pressable>
      <View style={{ alignItems: "center", justifyContent: "space-between", paddingVertical: 4, width: 32 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${card.key} 菜单`}
          onPress={onMenu}
          hitSlop={6}
          style={{ padding: 6 }}
        >
          <Icon name="MoreHorizontal" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
        {handle}
      </View>
    </View>
  );
}
