import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { UsageReportEntry } from "./types";
import { remainingPercent, resolveUsageRings, ringLevel, sortByRemaining } from "./rings";

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction;

function entry(
  id: string,
  windows: Array<{
    id: string;
    usedPct: number | null;
    durationMins?: number | null;
    resetsAt?: string | null;
  }>,
  overrides: Partial<UsageReportEntry> = {},
): UsageReportEntry {
  return {
    id,
    account: {},
    fetchedAt: "2026-10-29T00:00:00.000Z",
    sourceId: id,
    sourceLabel: id.toUpperCase(),
    report: {
      status: "available",
      windows: windows.map((window) => ({
        id: window.id,
        label: window.id,
        usedPct: window.usedPct,
        remainingPct: window.usedPct === null ? null : 100 - window.usedPct,
        resetsAt: window.resetsAt ?? null,
        windowDurationMins: window.durationMins,
      })),
    },
    ...overrides,
  } as UsageReportEntry;
}

describe("remainingPercent", () => {
  it("rounds the share left and clamps it to 0-100", () => {
    expect(remainingPercent({ id: "a", label: "a", usedPct: 37.6 })).toBe(62);
    expect(remainingPercent({ id: "a", label: "a", usedPct: 120 })).toBe(0);
    expect(remainingPercent({ id: "a", label: "a", usedPct: -5 })).toBe(100);
    expect(remainingPercent({ id: "a", label: "a", usedPct: null })).toBeNull();
  });
});

describe("ringLevel", () => {
  it("uses the 30% and 10% thresholds, inclusive at the lower bound", () => {
    expect(ringLevel(30)).toBe("success");
    expect(ringLevel(29)).toBe("warning");
    expect(ringLevel(10)).toBe("warning");
    expect(ringLevel(9)).toBe("danger");
    expect(ringLevel(0)).toBe("danger");
  });
});

describe("resolveUsageRings", () => {
  it("draws the longest window outside and the next inside, at most two", () => {
    const [account] = resolveUsageRings(
      [
        entry("codex", [
          { id: "weekly", usedPct: 10, durationMins: 10080 },
          { id: "five_hour", usedPct: 80, durationMins: 300 },
          { id: "monthly", usedPct: 50, durationMins: 43200 },
        ]),
      ],
      t,
    );
    expect(account?.rings.map((window) => window.id)).toEqual(["monthly", "weekly"]);
    expect(account?.windows.map((window) => window.id)).toEqual(["monthly", "weekly", "five_hour"]);
  });

  it("keeps report order for windows with no known length, after those with one", () => {
    const [account] = resolveUsageRings(
      [
        entry("x", [
          { id: "a", usedPct: 1 },
          { id: "b", usedPct: 2, durationMins: 300 },
          { id: "c", usedPct: 3 },
        ]),
      ],
      t,
    );
    expect(account?.windows.map((window) => window.id)).toEqual(["b", "a", "c"]);
  });

  it("takes the most constrained window as the account's remaining share and level", () => {
    const [account] = resolveUsageRings(
      [
        entry("claude", [
          { id: "five_hour", usedPct: 20 },
          { id: "weekly", usedPct: 95 },
        ]),
      ],
      t,
    );
    expect(account?.remaining).toBe(5);
    expect(account?.level).toBe("danger");
  });

  it("leaves out accounts with no windowed share, unavailable reports and balance-only reports", () => {
    const accounts = resolveUsageRings(
      [
        entry("none", [{ id: "a", usedPct: null }]),
        entry("off", [{ id: "a", usedPct: 1 }], {
          report: { status: "error", error: "boom" },
        } as Partial<UsageReportEntry>),
        entry("ok", [{ id: "a", usedPct: 40 }]),
      ],
      t,
    );
    expect(accounts.map((account) => account.reportId)).toEqual(["ok"]);
  });

  it("names an account with its label and groups each source's accounts together", () => {
    const accounts = resolveUsageRings(
      [
        entry("p1", [{ id: "a", usedPct: 1 }], {
          sourceId: "p",
          sourceLabel: "P",
          account: { label: "work" },
        }),
        entry("q", [{ id: "a", usedPct: 1 }], { sourceId: "q", sourceLabel: "Q" }),
        entry("p2", [{ id: "a", usedPct: 1 }], { sourceId: "p", sourceLabel: "P" }),
      ],
      t,
    );
    expect(accounts.map((account) => account.reportId)).toEqual(["p1", "p2", "q"]);
    expect(accounts[0]?.name).toBe("P · work");
  });
});

describe("sortByRemaining", () => {
  it("puts the account with the least share left first", () => {
    const accounts = resolveUsageRings(
      [entry("a", [{ id: "x", usedPct: 10 }]), entry("b", [{ id: "x", usedPct: 80 }])],
      t,
    );
    expect(sortByRemaining(accounts).map((account) => account.reportId)).toEqual(["b", "a"]);
  });
});

describe("resolveUsageRings with unavailable accounts", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const available = entry("claude", [{ id: "five_hour", usedPct: 40, durationMins: 300 }]);
  const expired = {
    ...entry("claude", []),
    fetchedAt: "2026-10-29T11:00:00.000Z",
    report: {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-10-29T10:00:00.000Z" },
    },
  } as UsageReportEntry;
  const remembered = (fetchedAt: string) => ({
    claude: {
      fetchedAt,
      report: available.report as Extract<UsageReportEntry["report"], { status: "available" }>,
    },
  });

  it("greys the last read of an account that turned unavailable, then recovers", () => {
    const [stale] = resolveUsageRings([expired], t, remembered("2026-10-29T09:00:00.000Z"), now);
    expect(stale?.stale).not.toBeNull();
    expect(stale?.remaining).toBe(60);
    expect(stale?.stale?.reason).toContain("staleReasonExpired");
    expect(stale?.accessibleLabel).toContain("providerUsage.staleSummary");
    const [fresh] = resolveUsageRings([available], t, remembered("2026-10-29T09:00:00.000Z"), now);
    expect(fresh?.stale).toBeNull();
  });

  it("hides a last read older than 24 hours", () => {
    expect(resolveUsageRings([expired], t, remembered("2026-10-28T11:00:00.000Z"), now)).toEqual(
      [],
    );
  });

  it("draws nothing for an account that was never read", () => {
    expect(resolveUsageRings([expired], t, {}, now)).toEqual([]);
  });

  it("falls back to the daemon's last successful read", () => {
    const withDaemon = {
      ...expired,
      lastSuccessful: remembered("2026-10-29T10:00:00.000Z").claude,
    } as UsageReportEntry;
    expect(resolveUsageRings([withDaemon], t, {}, now)[0]?.stale).not.toBeNull();
  });
});
