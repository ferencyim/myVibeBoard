import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import { formatProviderUsageLabel } from "./format";
import { usedPercent } from "./model";
import type { UsageReportEntry, UsageWindow } from "./types";

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

function resolveAccount(entry: UsageReportEntry, t: TFunction): RingAccount | null {
  if (entry.report.status !== "available") return null;
  const windows: RingWindow[] = [];
  for (const window of entry.report.windows) {
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
    accessibleLabel: `${name} usage: ${parts.join(", ")}. ${t("providerUsage.openUsage")}`,
  };
}

/**
 * The provider accounts that get a ring, in report order with each source's accounts together.
 * A report with no windowed limit (no usage, or only balances) gets none.
 */
export function resolveUsageRings(
  reports: readonly UsageReportEntry[],
  t: TFunction = i18n.t,
): RingAccount[] {
  const sourceIds = [...new Set(reports.map((entry) => entry.sourceId))];
  return sourceIds
    .flatMap((sourceId) => reports.filter((entry) => entry.sourceId === sourceId))
    .flatMap((entry) => {
      const account = resolveAccount(entry, t);
      return account ? [account] : [];
    });
}

/** The accounts with the least share left first: what the narrow rail summarises. */
export function sortByRemaining(accounts: readonly RingAccount[]): RingAccount[] {
  return [...accounts].sort((a, b) => a.remaining - b.remaining);
}
