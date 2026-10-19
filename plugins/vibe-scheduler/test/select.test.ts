import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILES,
  mergeProfiles,
  neededTier,
  parseWorkerHistory,
  selectAgent,
  type ProviderQuota,
} from "../server/vibe/contract";
import { normalizeUsage } from "../server/quota";
import { usage } from "./helpers";

const ok: ProviderQuota = { remainingPct: 80, level: "ok" };
const quota = (over: Record<string, ProviderQuota> = {}) => ({
  claude: ok,
  codex: ok,
  kimi: ok,
  deepseek: ok,
  ...over,
});

describe("selectAgent", () => {
  it("matches tier to size and priority", () => {
    expect(neededTier({ size: "S", priority: "low" })).toBe(1);
    expect(neededTier({ size: "S", priority: "urgent" })).toBe(2);
    expect(neededTier({ size: "XL", priority: "medium" })).toBe(3);
  });

  it("gives the strong agent to a big high priority task and the cheap one to a small low one", () => {
    const big = selectAgent(DEFAULT_PROFILES, { tags: ["refactor"], size: "L", priority: "high" }, { quota: quota() });
    const small = selectAgent(DEFAULT_PROFILES, { tags: ["docs"], size: "S", priority: "low" }, { quota: quota() });
    expect(["claude", "codex"]).toContain(big.agentId);
    expect(small.agentId).toBe("deepseek");
  });

  it("with the strong provider tight, high priority still gets it and low priority is steered away", () => {
    const q = quota({ claude: { remainingPct: 15, level: "tight", resetsAt: "2026-01-01T05:00:00Z" }, codex: { remainingPct: 15, level: "tight" } });
    const high = selectAgent(DEFAULT_PROFILES, { tags: ["refactor"], size: "L", priority: "high" }, { quota: q });
    expect(["claude", "codex"]).toContain(high.agentId);
    const low = selectAgent(DEFAULT_PROFILES, { tags: ["refactor"], size: "L", priority: "low" }, { quota: q });
    expect(["kimi", "deepseek"]).toContain(low.agentId);
    expect(low.excluded.map((e) => e.agentId)).toEqual(expect.arrayContaining(["claude", "codex"]));
  });

  it("waits for the reset when every candidate is out of quota", () => {
    const gone: ProviderQuota = { remainingPct: 1, level: "exhausted", resetsAt: "2026-01-01T05:00:00Z" };
    const s = selectAgent(DEFAULT_PROFILES, { tags: [], priority: "urgent" }, { quota: quota({ claude: gone, codex: gone, kimi: gone, deepseek: gone }) });
    expect(s.agentId).toBeNull();
    expect(s.wait).toEqual({ until: "2026-01-01T05:00:00Z", reason: "waiting for quota reset" });
  });

  it("honours the user's pre-selection even on a tight provider, with a warning", () => {
    const s = selectAgent(DEFAULT_PROFILES, { tags: [], priority: "low", preselected: "claude" }, { quota: quota({ claude: { remainingPct: 10, level: "tight" } }) });
    expect(s.agentId).toBe("claude");
    expect(s.warnings).toEqual(["claude quota is tight"]);
  });

  it("restricts by platform, device availability and memory", () => {
    const profiles = mergeProfiles([{ id: "kimi", provider: "kimi", tier: 2, strengths: [], platforms: ["web"] }]);
    const s = selectAgent(profiles, { tags: [], priority: "medium", platform: "android" }, { quota: quota() });
    expect(s.excluded).toContainEqual({ agentId: "kimi", why: "does not cover platform android" });
    expect(selectAgent(profiles, { tags: [], priority: "medium", device: "emulator" }, { quota: quota(), devicesFree: { emulator: 0 } }).wait?.reason).toMatch(/leased/);
    expect(selectAgent(profiles, { tags: [], priority: "medium" }, { quota: quota(), memoryPaused: true }).wait?.reason).toBe("memory pressure");
  });

  it("uses the MEMORY.md track record and current load as tie-breakers", () => {
    const md = ["# worker", "- ✓ fixed #android layout bug", "- ✓ passed #android emulator flow", "- ❌ failed #web build", ""].join("\n");
    const h = parseWorkerHistory(md);
    expect(h.android).toBeGreaterThan(0);
    expect(h.web).toBeLessThan(0);
    const profiles = [
      { id: "a", provider: "pa", tier: 2 as const, strengths: [] },
      { id: "b", provider: "pb", tier: 2 as const, strengths: [] },
    ];
    const s = selectAgent(profiles, { tags: ["android"], size: "M", priority: "medium" }, { quota: { pa: ok, pb: ok }, history: { b: h } });
    expect(s.agentId).toBe("b");
    const loaded = selectAgent(profiles, { tags: [], size: "M", priority: "medium" }, { quota: { pa: ok, pb: ok }, running: { pa: 3 } });
    expect(loaded.agentId).toBe("b");
  });
});

describe("normalizeUsage", () => {
  it("classifies the scarcest window", () => {
    const q = normalizeUsage(
      [
        ...usage(["claude", 80], ["codex", 99], ["kimi", 10], ["off", null]),
        { providerId: "multi", status: "available", windows: [{ usedPct: 10 }, { usedPct: 90, resetsAt: "r" }] },
      ],
      { tightPct: 25, exhaustedPct: 5 },
    );
    expect(q.claude).toMatchObject({ level: "tight", remainingPct: 20 });
    expect(q.codex?.level).toBe("exhausted");
    expect(q.kimi?.level).toBe("ok");
    expect(q.off?.level).toBe("unknown");
    expect(q.multi).toMatchObject({ remainingPct: 10, resetsAt: "r", level: "tight" });
  });
});
