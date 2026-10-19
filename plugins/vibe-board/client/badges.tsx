import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Text, View } from "react-native";
import {
  PRIORITY_LABELS,
  resolveColorHex,
  STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
  type TaskThreadLiveStatus,
} from "../shared/constants";

export function statusIconName(status: TaskStatus): string {
  switch (status) {
    case "backlog":
      return "CircleDashed";
    case "todo":
      return "Circle";
    case "in_progress":
      return "Clock";
    case "in_review":
      return "Eye";
    case "done":
      return "CheckCircle2";
    case "canceled":
      return "XCircle";
  }
}

export function statusColor(status: TaskStatus, theme: PluginTheme): string {
  switch (status) {
    case "backlog":
      return theme.colors.foregroundMuted;
    case "todo":
      return theme.colors.foreground;
    case "in_progress":
      return "#f59e0b";
    case "in_review":
      return "#3b82f6";
    case "done":
      return theme.colors.statusSuccess;
    case "canceled":
      return theme.colors.foregroundMuted;
  }
}

export function priorityIconName(priority: TaskPriority): string {
  switch (priority) {
    case "urgent":
      return "AlertTriangle";
    case "high":
      return "ArrowUp";
    case "medium":
      return "Equal";
    case "low":
      return "ArrowDown";
    case "none":
      return "Minus";
  }
}

export function priorityColor(priority: TaskPriority, theme: PluginTheme): string {
  switch (priority) {
    case "urgent":
      return theme.colors.statusDanger;
    case "high":
      return "#f97316";
    case "medium":
      return "#eab308";
    case "low":
      return "#3b82f6";
    case "none":
      return theme.colors.foregroundMuted;
  }
}

export function StatusIcon({
  status,
  theme,
  size = 14,
}: {
  status: TaskStatus;
  theme: PluginTheme;
  size?: number;
}) {
  return (
    <Icon
      name={statusIconName(status)}
      size={size}
      color={statusColor(status, theme)}
    />
  );
}

export function PriorityIcon({
  priority,
  theme,
  size = 14,
}: {
  priority: TaskPriority;
  theme: PluginTheme;
  size?: number;
}) {
  return (
    <Icon
      name={priorityIconName(priority)}
      size={size}
      color={priorityColor(priority, theme)}
    />
  );
}

export function StatusBadge({
  status,
  theme,
}: {
  status: TaskStatus;
  theme: PluginTheme;
}) {
  const color = statusColor(status, theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Icon name={statusIconName(status)} size={12} color={color} />
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 11,
          fontWeight: "600",
        }}
      >
        {STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

export function PriorityBadge({
  priority,
  theme,
}: {
  priority: TaskPriority;
  theme: PluginTheme;
}) {
  const color = priorityColor(priority, theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Icon name={priorityIconName(priority)} size={12} color={color} />
      <Text
        style={{
          color:
            priority === "none"
              ? theme.colors.foregroundMuted
              : theme.colors.foreground,
          fontSize: 11,
          fontWeight: "500",
        }}
      >
        {PRIORITY_LABELS[priority]}
      </Text>
    </View>
  );
}

export function ThreadLiveStatusBadge({
  status,
  theme,
}: {
  status: TaskThreadLiveStatus;
  theme: PluginTheme;
}) {
  const color =
    status === "working" || status === "starting"
      ? "#f59e0b"
      : status === "failed"
        ? theme.colors.statusDanger
        : status === "completed"
          ? theme.colors.statusSuccess
          : theme.colors.foregroundMuted;
  const label =
    status === "working"
      ? "Working"
      : status === "starting"
        ? "Starting"
        : status === "idle"
          ? "Idle"
          : status === "completed"
            ? "Completed"
            : "Failed";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 11,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function LabelPill({
  name,
  color,
  theme,
}: {
  name: string;
  color: string;
  theme: PluginTheme;
}) {
  const hex = resolveColorHex(color);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: hex,
        }}
      />
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 11,
          fontWeight: "500",
        }}
      >
        {name}
      </Text>
    </View>
  );
}

export function ProjectDot({
  color,
  size = 8,
}: {
  color: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: resolveColorHex(color),
      }}
    />
  );
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return iso.slice(0, 10);
}
