import React, { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ContextStatusSchema } from "./shared/status";
import type { PluginTimelineItemProps, PluginClientContext } from "@getpaseo/plugin/client";
import { ContextSettingsScreen } from "./client/settings";
import type { z } from "zod";

type ContextStatusData = z.infer<typeof ContextStatusSchema>;

function ContextStatusItem({ item, theme }: PluginTimelineItemProps<ContextStatusData>) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const foldable = useMemo(
    () => item.data.text.length > 360 || item.data.text.split("\n").length > 6,
    [item.data.text],
  );
  return (
    <View style={{ gap: 5, paddingVertical: 6 }}>
      <Text
        style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}
      >
        上下文
      </Text>
      <Text
        selectable={expanded}
        numberOfLines={expanded ? undefined : 6}
        style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}
      >
        {item.data.text}
      </Text>
      {foldable ? (
        <Pressable accessibilityRole="button" onPress={toggle} hitSlop={8}>
          <Text style={{ color: theme.colors.accent, fontSize: 12 }}>
            {expanded ? "收起" : "展开"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "context-status",
    version: 1,
    schema: ContextStatusSchema,
    Component: ContextStatusItem,
  });
  client.addSettingsScreen({
    id: "preferences",
    title: "上下文与压缩",
    icon: "Layers",
    Component: ContextSettingsScreen,
  });
  return () => {};
}
