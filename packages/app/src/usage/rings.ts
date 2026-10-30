import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import { formatProviderUsageLabel } from "./format";
import { usedPercent } from "./model";
import type { AvailableUsageReport, UsageReportEntry, UsageWindow } from "./types";

/** The colour of a remaining share: healthy green, low orange, nearly out red. */
export type RingLevel = "success" | "warning" | "danger";

/** One window of an account's ring, with the share still left in it. */
export interface RingWindow {
  id: string;
  label: string;
  shortLabel: string;
  /** Whole percent left, 0 to 100. */
  remaining: number;
  resetsAt: string | null;
  durationMins: number | null;
  level: RingLevel;
}

/** One provider account, drawn as a ring button. Only accounts with a windowed limit get one. */
export interface RingAccount {
  key: string;
  reportId: string;
  sourceLabel: string;
  /** Provider name, with the account label after it when the account has one. */
  name: string;
  icon: string | null;
  /** The most-constrained window's remaining percent: the one the ring summary sorts by. */
  remaining: number;
  level: RingLevel;
  /** Every windowed limit, longest first; the usage card lists them in this order. */
  windows: RingWindow[];
  /** At most two windows drawn: the longest outside, the next one inside. */
  rings: RingWindow[];
  /** The account's aria label: its name and each drawn window's share. */
  accessibleLabel: string;
  /** Set when the ring shows the last successful read because the source is unavailable now. */
  stale: RingStale | null;
}

/** The last good read an unavailable account still shows, greyed out. */
export interface RingStale {
  /** When the shown numbers were read (ISO). */
  at: string;
  /** Why the account cannot be read now, in words. */
  reason: string;
  /** "Last updated HH:mm; waiting to re-read (reason)". */
  summary: string;
}

/** The last successful read of one account, kept across restarts. */
export interface RememberedUsage {
  fetchedAt: string;
  report: AvailableUsageReport;
}

/** A remembered read older than this is too old to draw. */
export const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_RINGS = 2;

/** Whole percent left of a window, or null when the source reports no share. */
export function remainingPercent(window: UsageWindow): number | null {
  const used = usedPercent(window);
  if (used === null) return null;
  return Math.min(100, Math.max(0, Math.round(100 - used)));
}

/** Healthy at 30% or more left, low from 10% to 30%, critical below 10%. */
export function ringLevel(remaining: number): RingLevel {
  if (remaining >= 30) return "success";
  if (remaining >= 10) return "warning";
  return "danger";
}

/**
 * Windows longest first. A window without a known length keeps its report order after those
 * with one, so a source that reports no lengths still gets a stable outer ring.
 */
function longestFirst<T extends { durationMins: number | null }>(windows: readonly T[]): T[] {
  return windows
    .map((window, index) => ({ window, index }))
    .sort((a, b) => {
      const left = a.window.durationMins;
      const right = b.window.durationMins;
      if (left !== null && right !== null && left !== right) return right - left;
      if (left !== null && right === null) return -1;
      if (left === null && right !== null) return 1;
      return a.index - b.index;
    })
    .map(({ window }) => window);
}

function accountName(entry: UsageReportEntry): string {
  return entry.account.label ? `${entry.sourceLabel} · ${entry.account.label}` : entry.sourceLabel;
}

function staleReason(entry: UsageReportEntry, t: TFunction): string {
  const source = entry.sourceLabel;
  const report = entry.report;
  if (report.status === "unavailable") {
    const kind = report.problem.kind;
    if (kind === "expired") return t("providerUsage.staleReasonExpired", { source });
    if (kind === "rejected") return t("providerUsage.staleReasonRejected", { source });
    return t("providerUsage.staleReasonNoQuota", { source });
  }
  return t("providerUsage.staleReasonError", { source });
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The newest successful read of an entry: the daemon's, or the one this device remembered. */
function lastGood(entry: UsageReportEntry, remembered?: RememberedUsage): RememberedUsage | null {
  const fromDaemon = entry.lastSuccessful ?? null;
  if (!fromDaemon) return remembered ?? null;
  if (!remembered) return fromDaemon;
  return Date.parse(remembered.fetchedAt) > Date.parse(fromDaemon.fetchedAt)
    ? remembered
    : fromDaemon;
}

function resolveAccount(
  entry: UsageReportEntry,
  t: TFunction,
  remembered: RememberedUsage | undefined,
  now: number,
): RingAccount | null {
  let source: AvailableUsageReport;
  let stale: RingStale | null = null;
  if (entry.report.status === "available") {
    source = entry.report;
  } else {
    const good = lastGood(entry, remembered);
    const age = good ? now - Date.parse(good.fetchedAt) : Number.NaN;
    if (!good || !(age <= STALE_MAX_AGE_MS)) return null;
    source = good.report;
    const reason = staleReason(entry, t);
    stale = {
      at: good.fetchedAt,
      reason,
      summary: t("providerUsage.staleSummary", { time: formatClock(good.fetchedAt), reason }),
    };
  }
  const windows: RingWindow[] = [];
  for (const window of source.windows) {
    const remaining = remainingPercent(window);
    if (remaining === null) continue;
    windows.push({
      id: window.id,
      label: formatProviderUsageLabel(window.id, window.label, t),
      shortLabel: window.shortLabel ?? formatProviderUsageLabel(window.id, window.label, t),
      remaining,
      resetsAt: window.resetsAt ?? null,
      durationMins: window.windowDurationMins ?? null,
      level: ringLevel(remaining),
    });
  }
  if (windows.length === 0) return null;
  const ordered = longestFirst(windows);
  const remaining = Math.min(...ordered.map((window) => window.remaining));
  const name = accountName(entry);
  const parts = ordered.map(
    (window) =>
      `${window.label} ${t("providerUsage.values.remaining", { amount: `${window.remaining}%` })}`,
  );
  return {
    key: entry.id,
    reportId: entry.id,
    sourceLabel: entry.sourceLabel,
    name,
    icon: entry.icon ?? null,
    remaining,
    level: ringLevel(remaining),
    windows: ordered,
    rings: ordered.slice(0, MAX_RINGS),
    accessibleLabel: `${name} usage: ${parts.join(", ")}.${stale ? ` ${stale.summary}` : ""} ${t("providerUsage.openUsage")}`,
    stale,
  };
}

/**
 * The provider accounts that get a ring, in report order with each source's accounts together.
 * A report with no windowed limit (no usage, or only balances) gets none. An account that cannot
 * be read now keeps its ring, marked `stale`, while its last good read is under 24 hours old.
 */
export function resolveUsageRings(
  reports: readonly UsageReportEntry[],
  t: TFunction = i18n.t,
  remembered: Readonly<Record<string, RememberedUsage>> = {},
  now: number = Date.now(),
): RingAccount[] {
  const sourceIds = [...new Set(reports.map((entry) => entry.sourceId))];
  return sourceIds
    .flatMap((sourceId) => reports.filter((entry) => entry.sourceId === sourceId))
    .flatMap((entry) => {
      const account = resolveAccount(entry, t, remembered[entry.id], now);
      return account ? [account] : [];
    });
}

/** The accounts with the least share left first: what the narrow rail summarises. */
export function sortByRemaining(accounts: readonly RingAccount[]): RingAccount[] {
  return [...accounts].sort((a, b) => a.remaining - b.remaining);
}
