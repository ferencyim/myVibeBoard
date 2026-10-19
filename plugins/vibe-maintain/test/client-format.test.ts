import { describe, expect, it } from "vitest";
import { parseStatus, triggerText } from "../client/format";

describe("maintenance screen helpers", () => {
  it("describes triggers", () => {
    expect(triggerText("workload", { cards_done: 10, commits_merged: 30 })).toBe("every 10 cards done / 30 commits");
    expect(triggerText("time", { cron: "0 3 * * *" })).toBe("cron 0 3 * * *");
    expect(triggerText("event", { path: "logs/crash.log", pattern: "Exception" })).toContain("logs/crash.log");
  });

  it("reads the loose status record", () => {
    const view = parseStatus({
      rules: [
        {
          rule: { id: "r1", name: "git-health", projectId: "p1", triggerKind: "workload", trigger: { cards_done: 10 }, outputMode: "suggest", agent: null, priority: "low", dailyCap: 1, enabled: true, pausedAt: "2026-10-01T00:00:00Z" },
          counters: { cards: 4 },
          runsToday: 1,
          lastRun: { status: "fired", triggeredAt: "2026-10-01T03:00:00.000Z", cardIds: ["c1"] },
          blocked: "paused",
          projectName: "Demo",
        },
      ],
      configErrors: { p1: ["bad yaml"] },
    });
    expect(view.rules[0]).toMatchObject({
      name: "git-health",
      projectName: "Demo",
      paused: true,
      blocked: "paused",
      counters: { cards: 4 },
      lastRun: { status: "fired", cards: 1 },
    });
    expect(view.configErrors).toEqual([{ project: "p1", errors: ["bad yaml"] }]);
    expect(parseStatus(null)).toEqual({ rules: [], configErrors: [] });
  });
});
