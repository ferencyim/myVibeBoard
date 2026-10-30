import { Fragment, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, useWindowDimensions } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { formatPct, formatResetLabel } from "./format";
import { useUsageHostId } from "./hosts";
import { useRememberedUsage } from "./last-good";
import { useUsageHostReports, useUsageReportsAutoRefresh } from "./queries";
import {
  resolveUsageRings,
  sortByRemaining,
  type RingAccount,
  type RingLevel,
  type RingWindow,
} from "./rings";
import { UsageSourceIcon } from "./source-icon";
import { useRelativeTimeTick } from "./use-relative-time-tick";

// Geometry from the design spec: a 36px button holds a 34px SVG whose two rings share their
// centre. The outer ring sits at (34 - stroke) / 2 and the inner one a gap further in.
const BUTTON_SIZE = 36;
const SVG_SIZE = 34;
const CENTER = SVG_SIZE / 2;
const STROKE_WIDTH = 2.25;
const RING_GAP = 4.5;
const OUTER_RADIUS = (SVG_SIZE - STROKE_WIDTH) / 2;
const INNER_RADIUS = OUTER_RADIUS - RING_GAP;
const TRACK_OPACITY = 0.15;
/** A ring showing the last read of an unavailable account fades to this. */
const STALE_OPACITY = 0.45;
const LOGO_SIZE = 12;
const CARD_MAX_WIDTH = 300;
/** Narrow rails overlap their two rings by this much. */
const STACK_OVERLAP = 8;

interface RingColors {
  trackColor: string;
  successColor: string;
  warningColor: string;
  dangerColor: string;
}

const ringColors = (theme: Theme): RingColors => ({
  trackColor: theme.colors.foregroundMuted,
  successColor: theme.colors.statusSuccess,
  warningColor: theme.colors.statusWarning,
  dangerColor: theme.colors.statusDanger,
});

function levelColor(level: RingLevel, colors: RingColors): string {
  if (level === "success") return colors.successColor;
  if (level === "warning") return colors.warningColor;
  return colors.dangerColor;
}

/** The arc's dash: its length is the share left, so a full ring reads as nearly untouched. */
function arcDash(remaining: number, circumference: number): [number, number] {
  return [(remaining / 100) * circumference, circumference];
}

// The SVG is wrapped as one component: withUnistyles adds a div on web, which cannot sit in an SVG.
const RingGraphicBase = function RingGraphic({
  rings,
  trackColor,
  successColor,
  warningColor,
  dangerColor,
  stale,
}: RingColors & { rings: readonly RingWindow[]; stale: boolean }) {
  const colors = { trackColor, successColor, warningColor, dangerColor };
  return (
    <Svg
      width={SVG_SIZE}
      height={SVG_SIZE}
      viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {rings.map((ring, index) => {
        const radius = index === 0 ? OUTER_RADIUS : INNER_RADIUS;
        const circumference = 2 * Math.PI * radius;
        // SVG strokes start at three o'clock; the ring reads clockwise from twelve.
        const rotation = `rotate(-90 ${CENTER} ${CENTER})`;
        return (
          <Fragment key={ring.id}>
            <Circle
              cx={CENTER}
              cy={CENTER}
              r={radius}
              fill="none"
              stroke={trackColor}
              strokeOpacity={TRACK_OPACITY}
              strokeWidth={STROKE_WIDTH}
              transform={rotation}
            />
            {ring.remaining > 0 ? (
              <Circle
                cx={CENTER}
                cy={CENTER}
                r={radius}
                fill="none"
                stroke={stale ? trackColor : levelColor(ring.level, colors)}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
                strokeDasharray={arcDash(ring.remaining, circumference)}
                transform={rotation}
              />
            ) : null}
          </Fragment>
        );
      })}
    </Svg>
  );
};
const ThemedRingGraphic = withUnistyles(RingGraphicBase);

const ringColorProps = (theme: Theme) => ringColors(theme);

function UsageRingButton({
  account,
  onOpen,
}: {
  account: RingAccount;
  onOpen: (reportId: string) => void;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(CARD_MAX_WIDTH, width - 16);
  const { reportId } = account;
  const press = useCallback(() => onOpen(reportId), [onOpen, reportId]);
  return (
    <HoverCard>
      <HoverCardTrigger focusable accessibilityLabel={account.accessibleLabel}>
        <PressHighlight
          onPress={press}
          accessibilityRole="button"
          accessibilityLabel={account.accessibleLabel}
          testID={`usage-ring-${account.reportId}`}
          style={account.stale ? [styles.button, styles.staleButton] : styles.button}
        >
          <ThemedRingGraphic
            rings={account.rings}
            stale={account.stale !== null}
            uniProps={ringColorProps}
          />
          <View style={styles.logo} pointerEvents="none">
            <UsageSourceIcon svg={account.icon} size={LOGO_SIZE} />
          </View>
        </PressHighlight>
      </HoverCardTrigger>
      <HoverCardContent
        placement="right"
        alignment="end"
        offset={8}
        role="dialog"
        accessibilityLabel={t("providerUsage.title")}
        testID={`usage-ring-card-${account.reportId}`}
        style={[styles.card, { width: cardWidth }]}
      >
        <UsageRingCard account={account} />
      </HoverCardContent>
    </HoverCard>
  );
}

function UsageRingCard({ account }: { account: RingAccount }) {
  const { t } = useTranslation();
  const now = useRelativeTimeTick({ enabled: true });
  return (
    <View style={styles.cardBody}>
      <Text style={styles.cardTitle}>{t("providerUsage.title")}</Text>
      <Text style={styles.accountName}>{account.name}</Text>
      {account.stale ? (
        <Text style={styles.staleNote} testID={`usage-ring-stale-${account.reportId}`}>
          {account.stale.summary}
        </Text>
      ) : null}
      {account.windows.map((window) => (
        <ThemedWindowRow
          key={window.id}
          window={window}
          now={now}
          stale={account.stale !== null}
          uniProps={ringColorProps}
        />
      ))}
    </View>
  );
}

/** One window on the card: its name, a bar showing the share left, that share, and the reset. */
const WindowRowBase = function WindowRow({
  window,
  now,
  trackColor,
  successColor,
  warningColor,
  dangerColor,
  stale,
}: RingColors & { window: RingWindow; now: number; stale: boolean }) {
  // Healthy bars stay grey on the card; only low and critical windows take a colour.
  const colors = { trackColor, successColor, warningColor, dangerColor };
  const fill = stale || window.level === "success" ? trackColor : levelColor(window.level, colors);
  const reset = formatResetLabel(window.resetsAt, false, now);
  return (
    <View style={styles.windowRow}>
      <Text style={styles.windowLabel} numberOfLines={1}>
        {window.label}
      </Text>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${window.remaining}%`, backgroundColor: fill }]} />
      </View>
      <Text style={[styles.windowValue, { color: fill }]}>{formatPct(window.remaining)}</Text>
      <Text style={styles.reset} numberOfLines={1}>
        {reset ?? ""}
      </Text>
    </View>
  );
};
const ThemedWindowRow = withUnistyles(WindowRowBase);

/**
 * The usage rings of the usage host's accounts. Each account with a windowed limit gets one ring
 * button; the narrow rail shows the two least-left as an overlapping pair, with "+N" for the rest.
 */
export function UsageRings({
  horizontal = false,
  onOpen,
}: {
  horizontal?: boolean;
  onOpen: (reportId: string) => void;
}) {
  const { t } = useTranslation();
  const serverId = useUsageHostId();
  useUsageReportsAutoRefresh(serverId);
  const reports = useUsageHostReports(serverId);
  const remembered = useRememberedUsage(serverId, reports);
  const accounts = useMemo(
    () => resolveUsageRings(reports, t, remembered),
    [reports, t, remembered],
  );
  if (accounts.length === 0) return null;
  if (!horizontal) {
    return accounts.map((account) => (
      <UsageRingButton key={account.key} account={account} onOpen={onOpen} />
    ));
  }
  const ordered = sortByRemaining(accounts);
  const shown = ordered.slice(0, 2);
  const hidden = ordered.length - shown.length;
  return (
    <View style={styles.stack} testID="usage-rings-stack">
      {shown.map((account, index) => (
        <View key={account.key} style={index === 0 ? null : styles.stacked}>
          <UsageRingButton account={account} onOpen={onOpen} />
        </View>
      ))}
      {hidden > 0 ? <Text style={styles.more}>{`+${hidden}`}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  staleButton: {
    opacity: STALE_OPACITY,
  },
  staleNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  logo: {
    position: "absolute",
    top: (BUTTON_SIZE - LOGO_SIZE) / 2,
    left: (BUTTON_SIZE - LOGO_SIZE) / 2,
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  stack: {
    flexDirection: "row",
    alignItems: "center",
  },
  stacked: {
    marginLeft: -STACK_OVERLAP,
  },
  more: {
    marginLeft: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  card: {
    padding: theme.spacing[2],
  },
  cardBody: {
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.md,
    fontWeight: "600",
  },
  accountName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  windowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  windowLabel: {
    width: 72,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bar: {
    flex: 1,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  windowValue: {
    width: 40,
    textAlign: "right",
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  reset: {
    width: 84,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
