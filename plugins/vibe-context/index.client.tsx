import React from "react";
import { Text } from "react-native";
import { ContextStatusSchema } from "./shared/status";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ContextSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "context_status",
    version: 1,
    schema: ContextStatusSchema,
    Component: ({ item, theme }) => {
      const style = React.useMemo(
        () => ({ color: theme.colors.foregroundMuted }),
        [theme.colors.foregroundMuted],
      );
      return <Text style={style}>{item.data.text}</Text>;
    },
  });
  client.addSettingsScreen({
    id: "preferences",
    title: "上下文与压缩",
    icon: "Layers",
    Component: ContextSettingsScreen,
  });
  return () => {};
}
