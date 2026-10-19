import { describe, expect, it } from "vitest";
import {
  discussionOf,
  handoffAnswering,
  planReady,
  plannerSessionOf,
  sessionStatusLabel,
  userMessageBody,
  waitingForPlanner,
} from "../client/planning/logic";
import type { AgentSession, CardEvent } from "../shared/vibe/contract";

let n = 0;
function ev(authorKind: CardEvent["authorKind"], body: unknown, type: CardEvent["type"] = "note"): CardEvent {
  n++;
  return {
    id: `e${n}`,
    cardId: "c1",
    type,
    authorKind,
    author: authorKind === "agent" ? "planner" : "user",
    body,
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    updatedHlc: "",
  };
}

describe("discussion tab logic", () => {
  it("builds the thread, marks unanswered messages and skips other notes", () => {
    const first = ev("user", userMessageBody("hello"));
    const answer = ev("agent", { kind: "discussion", role: "planner", text: "hi", answers: [first.id], planVersion: 1 });
    const second = ev("user", userMessageBody("more"));
    const research = ev("agent", { kind: "discussion_research", text: "scout says" });
    const plain = ev("user", { text: "an ordinary comment" });
    const status = ev("system", { kind: "moved" }, "status");
    const items = discussionOf([first, answer, second, research, plain, status]);
    expect(items.map((i) => i.kind)).toEqual(["user", "planner", "user", "research"]);
    expect(items.map((i) => ("answered" in i ? i.answered : null))).toEqual([true, true, false, null]);
    expect(waitingForPlanner(items)).toBe(true);
    expect(waitingForPlanner(items.slice(0, 2))).toBe(false);
  });

  it("shows the ready hint only until the owner says something new", () => {
    const u = ev("user", userMessageBody("ok?"));
    const ready = ev("agent", { kind: "discussion", role: "planner", text: "ready", answers: [u.id], ready: true });
    expect(planReady(discussionOf([u, ready]))).toBe(true);
    expect(planReady(discussionOf([u, ready, ev("user", userMessageBody("wait"))]))).toBe(false);
    const failed = ev("agent", { kind: "discussion", role: "planner", text: "x", error: true, ready: true, answers: [] });
    expect(planReady(discussionOf([u, failed]))).toBe(false);
  });

  it("recognises the hand-off that answers a request", () => {
    const request = ev("user", { kind: "handoff_request" });
    const other = ev("agent", { kind: "handoff", text: "old", answers: ["zzz"] });
    const answer = ev("agent", { kind: "handoff", text: "new", answers: [request.id], path: "/r/.vibe/sessions/A-1-plan.md" });
    expect(handoffAnswering([request, other], request.id)).toBeUndefined();
    expect(handoffAnswering([request, other, answer], request.id)?.id).toBe(answer.id);
    expect(discussionOf([request, answer]).map((i) => i.kind)).toEqual(["handoff"]);
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
