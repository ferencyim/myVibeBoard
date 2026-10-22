import { describe, expect, it } from "vitest";
import { plannerSessionOf, plannerStatusLabel } from "../client/planning/logic";
import type { AgentSession } from "../shared/vibe/contract";

describe("planner session helpers", () => {
  it("labels the planner session", () => {
    const s = (role: string, state: string) => ({ role, state }) as AgentSession;
    expect(plannerStatusLabel(undefined)).toBe("尚未开始");
    expect(plannerStatusLabel(s("planner", "working"))).toBe("规划中…");
    expect(plannerStatusLabel(s("planner", "idle"))).toBe("等待你的回复");
    expect(plannerStatusLabel(s("planner", "error"))).toContain("出错");
    expect(plannerStatusLabel(s("planner", "ended"))).toBe("已结束");
    expect(plannerSessionOf([s("worker", "idle"), s("planner", "ended")])?.state).toBe("ended");
  });
});
