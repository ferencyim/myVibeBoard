import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import type { UsageReportEntry } from "./types";

/**
 * One card per report (source + account). Window rows pin while the sidebar summary is on. The
 * focused report, if any, is listed first and outlined.
 */
export function UsageList({
  serverId,
  reports,
  display,
  focusReportId = null,
}: {
  serverId: string;
  reports: UsageReportEntry[];
  display: UsageDisplay;
  focusReportId?: string | null;
}) {
  const { inSidebar } = useUsageInSidebar();
  const ordered = focusReportId
    ? [...reports].sort((a, b) => Number(b.id === focusReportId) - Number(a.id === focusReportId))
    : reports;
  return (
    <View style={styles.list}>
      {ordered.map((entry) => (
        <View
          key={entry.id}
          style={[settingsStyles.card, entry.id === focusReportId && styles.focused]}
        >
          <UsageCard
            serverId={serverId}
            entry={entry}
            display={display}
            pinnable={inSidebar}
            refreshable
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
  },
  focused: {
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
  },
}));
