import { describe, expect, it } from "vitest";
import { quotaLabel, switchChoices, targetLabel, thinkingChips } from "../client/format";
import type { ProviderInfo } from "../shared/rpc";

const providers: ProviderInfo[] = [
  {
    id: "claude",
    label: "claude",
    remainingPct: 63,
    level: "ok",
    models: [
      { id: "sonnet-x", label: "Sonnet X", isDefault: true, thinking: [] },
      { id: "opus-x", label: "Opus X", isDefault: false, thinking: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
    ],
  },
  {
    id: "codex",
    label: "codex",
    remainingPct: 9,
    level: "tight",
    models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true, thinking: [{ id: "xhigh", label: "XH" }, { id: "low", label: "L" }] }],
  },
];

describe("switch choices", () => {
  it("lists Opus first, adds a highest-reasoning choice per model that has levels, marks the active one", () => {
    const active = { provider: "claude", model: "opus-x", thinking: null };
    const choices = switchChoices(providers, active);
    expect(choices.map((c) => c.key)).toEqual([
      "claude:opus-x",
      "claude:opus-x:max",
      "claude:sonnet-x",
      "codex:gpt-5-codex",
      "codex:gpt-5-codex:max",
    ]);
    expect(choices.find((c) => c.active)?.key).toBe("claude:opus-x");
    const codexMax = choices.find((c) => c.key === "codex:gpt-5-codex:max")!;
    expect(codexMax.request).toEqual({ provider: "codex", model: "gpt-5-codex", thinking: "max" });
    expect(codexMax.detail).toBe("剩余 9% - 紧张");
  });

  it("formats labels", () => {
    expect(targetLabel(null)).toBe("尚未解析");
    expect(targetLabel({ provider: "codex", model: "m", thinking: "xhigh" })).toBe("codex / m（很高）");
    expect(quotaLabel({ remainingPct: null, level: "unknown" })).toBe("额度未知");
  });
});

describe("thinking chips of the settings page", () => {
  it("lists 默认 plus the levels of the chosen model, labelled in Chinese", () => {
    expect(thinkingChips(providers, "claude", "opus-x", "")).toEqual([
      { id: "", label: "默认" },
      { id: "low", label: "低" },
      { id: "high", label: "高" },
    ]);
    // A provider label that says more than the id wins (here "XH" / "L").
    expect(thinkingChips(providers, "codex", "gpt-5-codex", "xhigh").map((c) => c.label)).toEqual(["默认", "XH", "L"]);
  });

  it("an empty model means Opus for claude and the default model elsewhere", () => {
    expect(thinkingChips(providers, "claude", "", "").map((c) => c.id)).toEqual(["", "low", "high"]);
    expect(thinkingChips(providers, "codex", "", "").map((c) => c.id)).toEqual(["", "xhigh", "low"]);
  });

  it("keeps a saved value the model does not offer, and offers only 默认 for an unknown provider", () => {
    expect(thinkingChips(providers, "claude", "sonnet-x", "max")).toEqual([
      { id: "", label: "默认" },
      { id: "max", label: "最高（当前值）" },
    ]);
    expect(thinkingChips(providers, "nope", "", "")).toEqual([{ id: "", label: "默认" }]);
  });
});
