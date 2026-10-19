import { describe, expect, it } from "vitest";
import { defaultSelector, presetTier } from "../server/select";
import { neededTier } from "../server/vibe/contract";
import { setupBoard } from "./helpers";
import type { QuotaMap } from "../server/subscription/quota";

const q = (remainingPct: number | null, level: QuotaMap[string]["level"]): QuotaMap[string] => ({
  remainingPct,
  level,
  resetsAt: null,
});

describe("default sub-agent selector", () => {
  const board = setupBoard();
  const presets = board.store.presets.list();
  const base = { tags: ["feature"], presets, quota: {} as QuotaMap };

  it("maps model names and card needs to tiers", () => {
    expect(presetTier({ model: "opus", thinking: "high" })).toBe(3);
    expect(presetTier({ model: "haiku", thinking: "" })).toBe(1);
    expect(presetTier({ model: "kimi-k2", thinking: "default" })).toBe(2);
    expect(neededTier({ size: "S", priority: "low" })).toBe(1);
    expect(neededTier({ size: "M", priority: "high" })).toBe(3);
  });

  it("lets the strong agent go to large or high-priority work", () => {
    const big = defaultSelector({ ...base, priority: "medium", size: "XL" });
    expect(["Claude Opus", "Codex Max"]).toContain(big.presetName);
    const small = defaultSelector({ ...base, priority: "low", size: "S" });
    expect(small.presetName).toBe("Kimi");
  });

  it("keeps a tight provider for high priority and never uses an exhausted one", () => {
    const quota: QuotaMap = { claude: q(10, "tight"), codex: q(0, "exhausted"), kimi: q(90, "ok") };
    expect(defaultSelector({ ...base, quota, priority: "low", size: "XL" }).presetName).toBe("Kimi");
    expect(defaultSelector({ ...base, quota, priority: "urgent", size: "XL" }).presetName).toBe("Claude Opus");
    const allOut: QuotaMap = { claude: q(0, "exhausted"), codex: q(0, "exhausted"), kimi: q(0, "exhausted") };
    const none = defaultSelector({ ...base, quota: allOut, priority: "urgent", size: "M" });
    expect(none.presetId).toBeNull();
    expect(none.wait).toMatch(/quota/);
  });

  it("honours the owner's pre-selection unless it is exhausted", () => {
    const codex = presets.find((p) => p.name === "Codex Max")!;
    const chosen = defaultSelector({ ...base, priority: "low", size: "S", preselectedPresetId: codex.id });
    expect(chosen.presetId).toBe(codex.id);
    const quota: QuotaMap = { codex: q(0, "exhausted"), claude: q(80, "ok"), kimi: q(80, "ok") };
    expect(defaultSelector({ ...base, quota, priority: "low", size: "S", preselectedPresetId: codex.id }).presetId).not.toBe(codex.id);
  });
});
