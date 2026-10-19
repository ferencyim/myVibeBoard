import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, useRevealedText, useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Pressable, Text, View } from "react-native";
import {
  getTaskByKeyRpc,
  seedDemoRpc,
  type TaskCardData,
  type TaskTextData,
} from "../shared/contract";
import { tasksSettings } from "../shared/settings";
import { PriorityBadge, StatusBadge, StatusIcon } from "./badges";

export function TaskTimelineTextItem({
  item,
  theme,
}: PluginTimelineItemProps<TaskTextData>) {
  const revealed = useRevealedText(item.data.text, item.data.phase);
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text
        selectable
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {revealed}
      </Text>
    </View>
  );
}

export function TaskTimelineCardItem({
  item,
  theme,
  onOpenTask,
}: PluginTimelineItemProps<TaskCardData> & {
  onOpenTask: (taskKey: string) => void;
}) {
  const getTaskByKey = useRpc(getTaskByKeyRpc);
  const { taskKey, fallbackTitle, valid } = item.data;

  const taskQuery = useQuery({
    queryKey: ["tasks", "byKey", taskKey],
    queryFn: () => getTaskByKey({ taskKey }),
    enabled: valid && taskKey.length > 0,
    refetchInterval: 4000,
  });

  if (!valid) {
    return (
      <View
        style={{
          marginVertical: 6,
          padding: 12,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.statusDanger,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
          Invalid task link. Expected a task key like PROD-1.
        </Text>
      </View>
    );
  }

  const task = taskQuery.data?.task;

  if (taskQuery.isLoading) {
    return (
      <View
        style={{
          marginVertical: 6,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <StatusIcon status="backlog" theme={theme} />
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          {taskKey}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            flex: 1,
          }}
        >
          {fallbackTitle ?? "Loading task…"}
        </Text>
      </View>
    );
  }

  if (!task) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => onOpenTask(taskKey)}
        style={{
          marginVertical: 6,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <StatusIcon status="backlog" theme={theme} />
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          {taskKey}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            flex: 1,
          }}
        >
          {fallbackTitle
            ? `${fallbackTitle} · not found`
            : "Task not found — deleted or key changed"}
        </Text>
        <Icon name="ArrowUpRight" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.key} ${task.title}`}
      onPress={() => onOpenTask(task.key)}
      style={{
        marginVertical: 6,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <StatusIcon status={task.status} theme={theme} size={15} />
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "700",
        }}
      >
        {task.key}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
          flex: 1,
        }}
      >
        {task.title}
      </Text>
      <StatusBadge status={task.status} theme={theme} />
      {task.priority !== "none" ? (
        <PriorityBadge priority={task.priority} theme={theme} />
      ) : null}
      <Icon name="ArrowUpRight" size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

export function TasksSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(tasksSettings);
  const seedDemo = useRpc(seedDemoRpc);
  const toast = useToast();

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Loading Tasks settings…
        </Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={{ color: theme.colors.statusDanger }}>
          Could not load Tasks settings: {settings.error}
        </Text>
        <SettingsAction
          label="Reset settings"
          actionLabel="Reset"
          onPress={() => void settings.reset()}
        />
      </View>
    );
  }

  const { values, revision } = settings;

  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title="Agent Integration">
        <SettingsCard>
          <SettingsSwitch
            label="Inject paseo-tasks CLI and MCP server"
            hint="Automatically adds paseo-tasks (and bb-tasks) to agent PATH and registers the tasks MCP server on new agents."
            value={values.autoInjectCliAndMcp}
            onValueChange={(next) =>
              void settings.save(
                { ...values, autoInjectCliAndMcp: next },
                revision,
              )
            }
          />
          <SettingsSwitch
            label="Inject Tasks reporting instructions"
            hint="Appends concise instructions teaching worker agents how to comment, attach files, and emit ::task{key=...} cards."
            value={values.autoInjectInstructions}
            onValueChange={(next) =>
              void settings.save(
                { ...values, autoInjectInstructions: next },
                revision,
              )
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Board & List Defaults">
        <SettingsCard>
          <SettingsSelect
            label="Default view"
            value={values.defaultView}
            options={[
              { label: "Board (Kanban)", value: "board" },
              { label: "Grouped List", value: "list" },
            ]}
            onValueChange={(next) =>
              void settings.save(
                {
                  ...values,
                  defaultView: next === "list" ? "list" : "board",
                },
                revision,
              )
            }
          />
          <SettingsSwitch
            label="Show Done & Canceled lanes on Board"
            value={values.showCompletedInBoard}
            onValueChange={(next) =>
              void settings.save(
                { ...values, showCompletedInBoard: next },
                revision,
              )
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Evaluation Data">
        <SettingsCard>
          <SettingsAction
            label="Seed sample projects & tasks"
            hint="Creates sample Product, Operations, and Personal projects with tasks, subtasks, labels, and comments."
            actionLabel="Seed Demo"
            onPress={async () => {
              try {
                const res = await seedDemo({});
                toast.show(
                  `Seeded ${res.projectsCreated} projects and ${res.tasksCreated} tasks`,
                  { variant: "success" },
                );
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
