import { describe, expect, it } from "vitest";
import { quotaLabel, switchChoices, targetLabel } from "../client/format";
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
    expect(codexMax.detail).toBe("剩余 9% - tight");
  });

  it("formats labels", () => {
    expect(targetLabel(null)).toBe("尚未解析");
    expect(targetLabel({ provider: "codex", model: "m", thinking: "xhigh" })).toBe("codex / m (xhigh)");
    expect(quotaLabel({ remainingPct: null, level: "unknown" })).toBe("额度未知");
  });
});
