import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { taskStatusDataSchema } from "../shared/task-tabs";
import type { z } from "zod";

type TaskStatusData = z.infer<typeof taskStatusDataSchema>;

/** Compact task status row: first line as the heading, long bodies fold by default. */
export function TaskStatusItem({
  item,
  theme,
}: PluginTimelineItemProps<TaskStatusData>) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const { title, body, foldable } = useMemo(() => {
    const lines = item.data.text.split(/\r?\n/);
    const heading = lines[0]?.trim() || "任务状态";
    const rest = lines.slice(1).join("\n").trim();
    return {
      title: heading,
      body: rest,
      foldable: rest.length > 360 || rest.split("\n").length > 6,
    };
  }, [item.data.text]);
  const heading = useMemo(
    () => ({ color: theme.colors.foreground }),
    [theme.colors.foreground],
  );
  const muted = useMemo(
    () => ({ color: theme.colors.foregroundMuted }),
    [theme.colors.foregroundMuted],
  );
  const accent = useMemo(() => ({ color: theme.colors.accent }), [theme.colors.accent]);
  return (
    <View style={{ gap: 6, paddingVertical: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.colors.accent,
          }}
        />
        <Text style={[heading, { fontSize: 13, fontWeight: "600" }]}>{title}</Text>
      </View>
      {body ? (
        <Text
          selectable={expanded}
          numberOfLines={expanded ? undefined : 6}
          style={[muted, { fontSize: 13, lineHeight: 19 }]}
        >
          {body}
        </Text>
      ) : null}
      {foldable ? (
        <Pressable accessibilityRole="button" onPress={toggle} hitSlop={8}>
          <Text style={[accent, { fontSize: 12 }]}>{expanded ? "收起" : "展开"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
