import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../server/quota";
import { usage } from "./helpers";

describe("normalizeUsage", () => {
  it("classifies the scarcest window", () => {
    const q = normalizeUsage(
      [
        ...usage(["claude", 80], ["codex", 99], ["kimi", 10], ["off", null]),
        {
          providerId: "multi",
          status: "available",
          windows: [{ usedPct: 10 }, { usedPct: 90, resetsAt: "r" }],
        },
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
