import { describe, expect, it } from "vitest";
import { badgeOf, badgesByCard } from "../client/badges/logic";
import { describeEvent } from "../client/detail/events";
import { asOfLabel, buildOverview, formatWait, parseQuestion } from "../client/sessions/logic";
import type { AgentSession, CardView } from "../shared/vibe/contract";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function session(over: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    cardId: "c1",
    agentId: `agent-${over.id}`,
    workspaceId: null,
    role: "worker",
    currentProvider: "codex",
    switchHistory: [],
    state: "working",
    waitingSince: null,
    pendingQuestion: null,
    cacheExpiresAt: null,
    lastActivityAt: minutesAgo(1),
    startedAt: minutesAgo(30),
    endedAt: null,
    errorMessage: null,
    updatedHlc: "",
    ...over,
  };
}

const card = (id: string, column: CardView["column"] = "in_progress") => ({ id, column, key: id }) as CardView;
const question = (requestId: string) => ({ requestId, kind: "tool", name: "Bash", title: "Run ls" });

describe("buildOverview", () => {
  it("pins waiting sessions on top, longest wait first, then error, running, finished", () => {
    const rows = buildOverview(
      [
        session({ id: "idle", cardId: "c3", state: "idle" }),
        session({ id: "run", cardId: "c2", state: "working" }),
        session({ id: "w-new", cardId: "c1", state: "waiting", waitingSince: minutesAgo(2), pendingQuestion: question("q1") }),
        session({ id: "err", cardId: "c4", state: "error", errorMessage: "boom" }),
        session({ id: "w-old", cardId: "c5", state: "waiting", waitingSince: minutesAgo(40), pendingQuestion: question("q2") }),
      ],
      [card("c1"), card("c2"), card("c3", "verifying"), card("c4"), card("c5")],
      NOW,
    );
    expect(rows.map((r) => r.session.id)).toEqual(["w-old", "w-new", "err", "run", "idle"]);
    expect(rows[0]?.waitedMs).toBe(40 * 60_000);
    expect(rows[0]?.question?.requestId).toBe("q2");
  });

  it("drops long-ended sessions and idle sessions of cards that moved on", () => {
    const rows = buildOverview(
      [
        session({ id: "old", state: "ended", endedAt: minutesAgo(300) }),
        session({ id: "fresh", cardId: "c2", state: "ended", endedAt: minutesAgo(5) }),
        session({ id: "done", cardId: "c3", state: "idle" }),
      ],
      [card("c1"), card("c2", "verifying"), card("c3", "done")],
      NOW,
    );
    expect(rows.map((r) => r.session.id)).toEqual(["fresh"]);
  });
});

describe("badges", () => {
  it("waiting beats everything and shows the open question", () => {
    const map = badgesByCard([
      session({ id: "a", state: "working" }),
      session({ id: "b", state: "waiting", pendingQuestion: question("q") }),
    ]);
    expect(map.get("c1")).toMatchObject({ label: "等待审批", tone: "danger", detail: "Run ls" });
  });

  it("question kind asks for an answer; error carries the message; ended shows nothing", () => {
    const q = { requestId: "q", kind: "question", input: { questions: [{ question: "Which db?" }] } };
    expect(badgeOf(session({ id: "a", state: "waiting", pendingQuestion: q }))).toMatchObject({
      label: "等待回答",
      detail: "Which db?",
    });
    expect(badgeOf(session({ id: "b", state: "error", errorMessage: "boom" }))?.detail).toBe("boom");
    expect(badgeOf(session({ id: "c", state: "ended" }))).toBeNull();
  });
});

describe("wording", () => {
  it("formats waits and the offline as-of time", () => {
    expect(formatWait(20_000)).toBe("刚刚");
    expect(formatWait(5 * 60_000)).toBe("5 分钟");
    expect(formatWait(135 * 60_000)).toBe("2 小时 15 分");
    expect(asOfLabel(null)).toBe("尚未同步过");
    expect(asOfLabel(new Date(2026, 9, 19, 9, 5).getTime())).toBe("截至 09:05");
  });

  it("parses malformed questions as none", () => {
    expect(parseQuestion(null)).toBeNull();
    expect(parseQuestion({ kind: "tool" })).toBeNull();
  });

  it("describes session and reply timeline events", () => {
    expect(describeEvent({ type: "status", body: { kind: "session_waiting" } })).toBe("会话在等你回复");
    expect(describeEvent({ type: "status", body: { kind: "session_error", message: "x" } })).toBe("会话出错：x");
    expect(describeEvent({ type: "note", body: { kind: "reply", text: "yes" } })).toBe("已回复：yes");
    expect(describeEvent({ type: "note", body: { kind: "reply_stale", reason: "already_answered", text: "yes" } })).toContain(
      "问题已被回答",
    );
  });
});
