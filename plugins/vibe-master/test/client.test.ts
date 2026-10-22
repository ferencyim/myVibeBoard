import { describe, expect, it } from "vitest";
import { dispatchLabel, presetChoices, quotaLabel, targetLabel } from "../client/format";
import type { PresetChoice } from "../shared/rpc";

const preset = (id: string, roleHints: string[]): PresetChoice => ({
  id,
  name: id,
  provider: "claude",
  model: "opus-x",
  thinking: "high",
  roleHints,
  remainingPct: 63,
  level: "ok",
});

describe("preset picker", () => {
  it("offers presets open to any purpose or tagged planner, and always keeps the chosen one", () => {
    const presets = [preset("open", []), preset("planner", ["planner"]), preset("worker", ["worker"]), preset("both", ["worker", "planner"])];
    expect(presetChoices(presets, "").map((p) => p.id)).toEqual(["open", "planner", "both"]);
    expect(presetChoices(presets, "worker").map((p) => p.id)).toEqual(["open", "planner", "worker", "both"]);
  });

  it("formats labels", () => {
    expect(targetLabel(null)).toBe("尚未解析");
    expect(targetLabel({ provider: "codex", model: "m", thinking: "xhigh" })).toBe("codex / m（很高）");
    expect(quotaLabel({ remainingPct: null, level: "unknown" })).toBe("额度未知");
    expect(quotaLabel({ remainingPct: 9, level: "tight" })).toBe("剩余 9% - 紧张");
  });

  it("says who decides the dispatch and why the scheduler does when the master cannot", () => {
    expect(dispatchLabel({ enabled: false, available: true, reason: "" })).toContain("调度器按规则");
    expect(dispatchLabel({ enabled: true, available: false, reason: "没有为总 agent 选择预设" })).toContain("没有为总 agent 选择预设");
    expect(dispatchLabel({ enabled: true, available: true, reason: "" })).toContain("由总 agent 选择");
  });
});
