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
  /** Who the read came from, so the account keeps its ring when the daemon stops listing it. */
  source?: { sourceId: string; sourceLabel: string; icon?: string; accountLabel?: string };
}

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

/** A source that has no quota at all (not a failed read) draws no ring. */
function isNoQuota(entry: UsageReportEntry): boolean {
  return entry.report.status === "unavailable" && entry.report.problem.kind === "no_quota";
}

/**
 * Whether a never-read account is a live subscription worth a ring: its provider is enabled in
 * Paseo and the login is not refused. A rejected login or a source with no quota is not one.
 */
function isLiveSubscription(entry: UsageReportEntry, enabledProviders: ReadonlySet<string>) {
  if (!enabledProviders.has(entry.sourceId)) return false;
  if (entry.report.status !== "unavailable") return true;
  return entry.report.problem.kind !== "rejected" && entry.report.problem.kind !== "no_quota";
}

function placeholderAccount(entry: UsageReportEntry, t: TFunction): RingAccount {
  const name = accountName(entry);
  const reason = staleReason(entry, t);
  const summary = t("providerUsage.staleNever", { reason });
  return {
    key: entry.id,
    reportId: entry.id,
    sourceLabel: entry.sourceLabel,
    name,
    icon: entry.icon ?? null,
    // Sorts first so the narrow rail never folds an unreadable account into "+N".
    remaining: 0,
    level: "danger",
    windows: [],
    rings: [],
    accessibleLabel: `${name} usage: ${summary} ${t("providerUsage.openUsage")}`,
    stale: { at: entry.fetchedAt, reason, summary },
  };
}

/**
 * An account that cannot be read keeps its ring however old the last read is, greyed; one that
 * was never read gets an empty grey ring that says why. A source with no quota, or an available
 * report with no windowed limit (balances only), has no ring.
 */
function resolveAccount(
  entry: UsageReportEntry,
  t: TFunction,
  remembered: RememberedUsage | undefined,
  enabledProviders: ReadonlySet<string>,
): RingAccount | null {
  let source: AvailableUsageReport;
  let stale: RingStale | null = null;
  if (entry.report.status === "available") {
    source = entry.report;
  } else {
    const good = lastGood(entry, remembered);
    if (!good)
      return isLiveSubscription(entry, enabledProviders) ? placeholderAccount(entry, t) : null;
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
  if (windows.length === 0) return stale && !isNoQuota(entry) ? placeholderAccount(entry, t) : null;
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
 * An account the device read before but the daemon no longer lists (its login could not even be
 * discovered) as an entry that cannot be reached now, so it keeps its greyed ring. A source the
 * daemon still lists under another account id is left to that listing.
 */
function missingEntries(
  reports: readonly UsageReportEntry[],
  remembered: Readonly<Record<string, RememberedUsage>>,
): UsageReportEntry[] {
  const ids = new Set(reports.map((entry) => entry.id));
  const sources = new Set(reports.map((entry) => entry.sourceId));
  const entries: UsageReportEntry[] = [];
  for (const [id, memory] of Object.entries(remembered)) {
    if (ids.has(id)) continue;
    const sourceId = memory.source?.sourceId ?? id.split(":")[0] ?? id;
    if (sources.has(sourceId)) continue;
    const fallbackLabel = sourceId.charAt(0).toUpperCase() + sourceId.slice(1);
    entries.push({
      id,
      sourceId,
      sourceLabel: memory.source?.sourceLabel ?? fallbackLabel,
      icon: memory.source?.icon,
      account: memory.source?.accountLabel ? { label: memory.source.accountLabel } : {},
      fetchedAt: memory.fetchedAt,
      report: { status: "error", error: "not listed by the host" },
    } as UsageReportEntry);
  }
  return entries;
}

/**
 * The provider accounts that get a ring, in report order with each source's accounts together:
 * every account that was ever read (greyed while it cannot be read now, or when the host stops
 * listing it) and every never-read account whose provider is enabled in Paseo and whose login
 * is not refused. A report with no windowed limit (balances only) or no quota gets none.
 */
export function resolveUsageRings(
  reports: readonly UsageReportEntry[],
  t: TFunction = i18n.t,
  remembered: Readonly<Record<string, RememberedUsage>> = {},
  enabledProviders: ReadonlySet<string> = new Set(),
): RingAccount[] {
  const all = [...reports, ...missingEntries(reports, remembered)];
  const sourceIds = [...new Set(all.map((entry) => entry.sourceId))];
  return sourceIds
    .flatMap((sourceId) => all.filter((entry) => entry.sourceId === sourceId))
    .flatMap((entry) => {
      const account = resolveAccount(entry, t, remembered[entry.id], enabledProviders);
      return account ? [account] : [];
    });
}

/** The accounts with the least share left first: what the narrow rail summarises. */
export function sortByRemaining(accounts: readonly RingAccount[]): RingAccount[] {
  return [...accounts].sort((a, b) => a.remaining - b.remaining);
}
