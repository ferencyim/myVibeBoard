import { describe, expect, it } from "vitest";
import { fmtCost, fmtCostNote, fmtDuration, fmtTokens, shares } from "../client/format";

describe("format helpers", () => {
  it("formats tokens, cost and durations", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(12_345)).toBe("12.3k");
    expect(fmtTokens(2_500_000)).toBe("2.50M");
    expect(fmtCost(1.234)).toBe("$1.23");
    expect(fmtDuration(125_000)).toBe("2m 5s");
    expect(fmtDuration(3_660_000)).toBe("1h 1m");
  });

  it("marks unpriced tokens instead of showing a bare zero", () => {
    expect(fmtCostNote(1.5, 0)).toBe("$1.50");
    expect(fmtCostNote(0, 1500)).toBe("价格未知（1.5k token 未定价）");
    expect(fmtCostNote(2, 1500)).toBe("$2.00 + 1.5k token 未定价");
  });

  it("computes bar shares and tolerates empty input", () => {
    expect(shares([1, 3])).toEqual([0.25, 0.75]);
    expect(shares([0, 0])).toEqual([0, 0]);
  });
});
