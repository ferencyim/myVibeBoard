import { describe, expect, it } from "vitest";
import {
  dispatchLabel,
  presetChoices,
  presetModelLabel,
  quotaLabel,
  targetLabel,
} from "../client/format";
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
  it("offers every preset regardless of its role hints", () => {
    const presets = [
      preset("open", []),
      preset("planner", ["planner"]),
      preset("worker", ["worker"]),
      preset("both", ["worker", "planner"]),
    ];
    expect(presetChoices(presets).map((p) => p.id)).toEqual(["open", "planner", "worker", "both"]);
  });

  it("shows candidate models in their configured fallback order", () => {
    const value = preset("ordered", []);
    value.models = [
      { provider: "codex", model: "first", thinking: "xhigh" },
      { provider: "claude", model: "next", thinking: "high" },
    ];
    expect(presetModelLabel(value)).toBe("codex / first（很高） → claude / next（高）");
    expect(presetModelLabel(preset("legacy", []))).toBe("claude / opus-x（高）");
  });

  it("formats labels", () => {
    expect(targetLabel(null)).toBe("尚未解析");
    expect(targetLabel({ provider: "codex", model: "m", thinking: "xhigh" })).toBe(
      "codex / m（很高）",
    );
    expect(quotaLabel({ remainingPct: null, level: "unknown" })).toBe("额度未知");
    expect(quotaLabel({ remainingPct: 9, level: "tight" })).toBe("剩余 9% - 紧张");
  });

  it("says who decides the dispatch and why the scheduler does when the master cannot", () => {
    expect(dispatchLabel({ enabled: false, available: true, reason: "" })).toContain(
      "调度器按规则",
    );
    expect(
      dispatchLabel({ enabled: true, available: false, reason: "没有为总 agent 选择预设" }),
    ).toContain("没有为总 agent 选择预设");
    expect(dispatchLabel({ enabled: true, available: true, reason: "" })).toContain(
      "由总 agent 选择",
    );
  });
});
