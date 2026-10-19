// Real-log reconciliation against ccusage. Opt-in because it reads the machine's own Claude logs and
// needs ccusage (VIBE_CCUSAGE_CMD, default "npx ccusage", which downloads it on first use):
//   VIBE_E2E_CCUSAGE=1 npm test -- reconcile
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { computeOverview } from "../server/aggregate";
import { createIndexer } from "../server/indexer";
import { defaultLogDirs, resolveRoots } from "../server/paths";
import { openTestDb } from "./helpers";

interface CcusageDaily {
  daily: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>;
}

describe.skipIf(!process.env.VIBE_E2E_CCUSAGE)("ccusage reconciliation (real logs)", () => {
  it("daily Claude token totals equal ccusage daily --json", async () => {
    const [cmd, ...args] = (process.env.VIBE_CCUSAGE_CMD ?? "npx ccusage").split(" ");
    const out = execFileSync(cmd ?? "npx", [...args, "daily", "--json", "--offline"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const reference = JSON.parse(out) as CcusageDaily;

    const db = openTestDb();
    const claudeOnly = resolveRoots({}, { ...defaultLogDirs(), codex: [], kimi: [], deepseek: [] })
      .filter((r) => r.provider === "claude");
    await createIndexer({ db, roots: () => claudeOnly }).scan();
    const mine = new Map(computeOverview(db, "all").byDay.map((d) => [d.key, d]));

    expect([...mine.keys()].sort()).toEqual(reference.daily.map((d) => d.date).sort());
    for (const day of reference.daily) {
      const got = mine.get(day.date);
      expect([got?.input, got?.output, got?.cacheWrite, got?.cacheRead]).toEqual([
        day.inputTokens,
        day.outputTokens,
        day.cacheCreationTokens,
        day.cacheReadTokens,
      ]);
    }
  }, 600_000);
});
