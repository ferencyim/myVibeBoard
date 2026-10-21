import { describe, expect, it } from "vitest";
import {
  HANDOFF_REQUEST_BODY,
  handoffAnswering,
  plannerSessionOf,
  sessionStatusLabel,
} from "../client/planning/logic";
import type { AgentSession } from "../shared/vibe/contract";
import { chatEv, resetEvents } from "./chat-helpers";

describe("planner session helpers", () => {
  it("recognises the hand-off that answers a request", () => {
    resetEvents();
    const request = chatEv("user", HANDOFF_REQUEST_BODY, "note");
    const other = chatEv("agent", { kind: "handoff", text: "old", answers: ["zzz"] }, "note");
    const answer = chatEv(
      "agent",
      { kind: "handoff", text: "new", answers: [request.id], path: "/r/.vibe/sessions/A-1-plan.md" },
      "note",
    );
    expect(handoffAnswering([request, other], request.id)).toBeUndefined();
    expect(handoffAnswering([request, other, answer], request.id)?.id).toBe(answer.id);
    // a user note with the same shape is not a hand-off
    const fake = chatEv("user", { kind: "handoff", text: "x", answers: [request.id] }, "note");
    expect(handoffAnswering([request, fake], request.id)).toBeUndefined();
  });

  it("labels the planner session", () => {
    const s = (role: string, state: string) => ({ role, state }) as AgentSession;
    expect(sessionStatusLabel(undefined)).toBe("尚未开始");
    expect(sessionStatusLabel(s("planner", "working"))).toBe("规划中…");
    expect(sessionStatusLabel(s("planner", "idle"))).toBe("等待你的回复");
    expect(sessionStatusLabel(s("planner", "ended"))).toBe("已归档");
    expect(plannerSessionOf([s("worker", "idle"), s("planner", "ended")])?.state).toBe("ended");
  });
});
