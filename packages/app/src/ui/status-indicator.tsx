import { Check, Clock3, MessageCircle, X } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

export type StatusIndicatorStatus =
  | "working"
  | "responded"
  | "unread"
  | "waiting"
  | "failed"
  | "routine";

export interface StatusIndicatorProps {
  status: StatusIndicatorStatus;
  count?: number;
  label?: string;
}

const RespondedIcon = withUnistyles(Check, (theme) => ({ color: theme.colors.successText }));
const WaitingIcon = withUnistyles(MessageCircle, (theme) => ({ color: theme.colors.warningText }));
const FailedIcon = withUnistyles(X, (theme) => ({ color: theme.colors.dangerText }));
const RoutineIcon = withUnistyles(Clock3, (theme) => ({ color: theme.colors.textMuted }));
const labels: Record<StatusIndicatorStatus, string> = {
  working: "工作中",
  responded: "已回复",
  unread: "未读",
  waiting: "等待你",
  failed: "失败",
  routine: "例程",
};

export function StatusIndicator({ status, count = 1, label }: StatusIndicatorProps) {
  let content;
  switch (status) {
    case "working":
      content = (
        <View style={styles.working}>
          <View style={styles.dot} />
          <View style={styles.dot} />
          <View style={styles.dot} />
        </View>
      );
      break;
    case "responded":
      content = (
        <View style={styles.responded}>
          <RespondedIcon size={12} strokeWidth={2} />
        </View>
      );
      break;
    case "unread": {
      const countLabel = count > 99 ? "99+" : String(count);
      content = (
        <View style={styles.unread}>
          <Text style={styles.count}>{countLabel}</Text>
        </View>
      );
      break;
    }
    case "waiting":
      content = <WaitingIcon size={16} strokeWidth={1.5} />;
      break;
    case "failed":
      content = <FailedIcon size={16} strokeWidth={2} />;
      break;
    case "routine":
      content = <RoutineIcon size={16} strokeWidth={1.5} />;
      break;
  }
  const accessibleLabel = label ?? labels[status];
  const statusLabel = status === "unread" ? `${accessibleLabel} ${count}` : accessibleLabel;
  return (
    <View accessible accessibilityLabel={statusLabel} style={styles.container}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: 20,
    minHeight: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  working: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    width: 24,
    height: 16,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentSoft,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentText,
  },
  responded: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.successSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  unread: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.primary,
  },
  count: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.lineHeight.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.primaryForeground,
  },
}));
