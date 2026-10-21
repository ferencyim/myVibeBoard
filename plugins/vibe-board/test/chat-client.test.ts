import { beforeEach, describe, expect, it } from "vitest";
import { describeEvent } from "../client/detail/events";
import {
  chatItemsOf,
  headerActions,
  masterBusy,
  planReady,
  proposalDiff,
  routeHint,
  type MessageItem,
  type ProposalItem,
} from "../client/planning/logic";
import type { AgentSession, CardView } from "../shared/vibe/contract";
import { chatEv, resetEvents } from "./chat-helpers";

beforeEach(resetEvents);

const card = (column: CardView["column"], extra: Partial<CardView> = {}) =>
  ({ column, title: "T", description: "D", acceptance: "A", ...extra }) as CardView;
const sess = (role: string, state: string) => ({ role, state }) as AgentSession;
const msgs = (items: ReturnType<typeof chatItemsOf>) =>
  items.filter((i): i is MessageItem => i.kind === "message");

describe("chatItemsOf", () => {
  it("labels authors, kinds and extras, and marks answered user messages", () => {
    const u1 = chatEv("user", { text: "hi" });
    const m = chatEv("master", {
      text: "plan",
      answers: [u1.id],
      kind: "summary",
      planVersion: 2,
      ready: true,
      agentId: "ag1",
      detail: "long",
    });
    const u2 = chatEv("user", { text: "more" });
    const ex = chatEv("executor", { text: "working" });
    const rv = chatEv("reviewer", { text: "bad", kind: "verdict", error: true });
    const sc = chatEv("scout", { text: "found", kind: "info" });
    const items = msgs(chatItemsOf([u1, m, u2, ex, rv, sc]));
    expect(items.map((i) => i.label)).toEqual(["你", "总 agent", "你", "执行 agent", "复核", "探路兵"]);
    expect(items.map((i) => i.answered)).toEqual([true, true, false, true, true, true]);
    expect(items[1]).toMatchObject({
      msgKindLabel: "总结",
      planVersion: 2,
      ready: true,
      agentId: "ag1",
      detail: "long",
    });
    expect(items[4]).toMatchObject({ msgKindLabel: "结论", error: true });
    expect(items[5]!.msgKindLabel).toBe("说明");
  });

  it("derives system rows from a whitelist of status and reject events", () => {
    const events = [
      chatEv("system", { kind: "moved", from: "todo", to: "in_progress", reason: "派发" }, "status"),
      chatEv("system", { kind: "verification", text: "通过" }, "status"),
      chatEv("system", { kind: "dispatch_failed", message: "没有 agent" }, "status"),
      chatEv("system", { kind: "finalized", text: "已合并" }, "status"),
      chatEv("system", { kind: "created", column: "draft" }, "status"),
      chatEv("system", { kind: "other", text: "ignored" }, "status"),
      chatEv("user", { kind: "discussion", text: "old" }, "note"),
      chatEv("system", { score: 1 }, "evaluation"),
      chatEv("system", { text: "测试没过" }, "reject"),
      chatEv("system", { text: "已转给执行 agent", kind: "info" }),
    ];
    const items = chatItemsOf(events);
    expect(
      items.map((i) => (i.kind === "message" ? `m:${i.author}` : i.kind === "system" ? i.text : i.kind)),
    ).toEqual([
      "待办 → 进行中（派发）",
      "通过",
      "没有 agent",
      "已合并",
      "退回：测试没过",
      "m:system",
    ]);
    expect(items[1]).toMatchObject({ link: "verification" });
  });

  it("builds proposals with status labels and diffs", () => {
    const mk = (status: string, before?: object) =>
      chatEv(
        "master",
        { changes: { title: "New", acceptance: "ok" }, rationale: "why", status, before },
        "proposal",
      );
    const events = [
      mk("pending"),
      mk("accepted", { title: "Old" }),
      mk("rejected"),
      mk("superseded", { title: "Older", acceptance: "meh" }),
    ];
    const props = chatItemsOf(events) as ProposalItem[];
    expect(props.map((p) => p.statusLabel)).toEqual(["待处理", "已采纳", "已拒绝", "已被新建议取代"]);
    const c = card("draft", { title: "Now", acceptance: "cur" });
    expect(proposalDiff(props[0]!, c)).toEqual([
      { field: "title", label: "标题", before: "Now", after: "New" },
      { field: "acceptance", label: "验收标准", before: "cur", after: "ok" },
    ]);
    expect(proposalDiff(props[1]!, c).map((d) => d.before)).toEqual(["Old", undefined]);
    expect(proposalDiff(props[2]!, c).map((d) => d.before)).toEqual([undefined, undefined]);
    expect(proposalDiff(props[3]!, c).map((d) => d.before)).toEqual(["Older", "meh"]);
  });
});

describe("routing display", () => {
  it("routeHint per column", () => {
    expect(routeHint(card("draft"), [])).toContain("总 agent");
    expect(routeHint(card("todo"), [sess("worker", "idle")])).toContain("总 agent");
    for (const state of ["starting", "working", "waiting", "idle"]) {
      expect(routeHint(card("in_progress"), [sess("worker", state)])).toBe("消息将发给执行 agent");
    }
    expect(routeHint(card("verifying"), [sess("worker", "idle")])).toBe("消息将发给执行 agent");
    expect(routeHint(card("in_progress"), [sess("worker", "ended"), sess("planner", "idle")])).toBe(
      "执行 agent 已不在，消息将发给总 agent",
    );
    expect(routeHint(card("verifying"), [])).toContain("已不在");
    expect(routeHint(card("done"), [])).toBe("卡片已完成，发言只作记录");
  });

  it("masterBusy counts only unanswered messages the master handles", () => {
    const u = chatEv("user", { text: "q" });
    const items = chatItemsOf([u]);
    expect(masterBusy(items, card("draft"), [])).toBe(true);
    expect(masterBusy(items, card("in_progress"), [sess("worker", "working")])).toBe(false);
    expect(masterBusy(items, card("in_progress"), [])).toBe(true);
    expect(masterBusy(items, card("done"), [])).toBe(false);
    const fb = chatEv("system", { text: "转发失败", fallback: [u.id] });
    expect(masterBusy(chatItemsOf([u, fb]), card("in_progress"), [sess("worker", "working")])).toBe(true);
    const answered = chatEv("master", { text: "a", answers: [u.id] });
    expect(masterBusy(chatItemsOf([u, answered]), card("draft"), [])).toBe(false);
  });

  it("planReady until the owner speaks again or the reply failed", () => {
    const u = chatEv("user", { text: "ok?" });
    const ready = chatEv("master", { text: "ready", answers: [u.id], ready: true });
    expect(planReady(chatItemsOf([u, ready]))).toBe(true);
    expect(planReady(chatItemsOf([u, ready, chatEv("system", { text: "x" })]))).toBe(true);
    expect(planReady(chatItemsOf([u, ready, chatEv("user", { text: "wait" })]))).toBe(false);
    expect(planReady(chatItemsOf([u, chatEv("master", { text: "x", error: true, ready: true })]))).toBe(
      false,
    );
    expect(planReady([])).toBe(false);
  });

  it("headerActions by column", () => {
    expect(headerActions(card("draft")).map((a) => a.label)).toEqual(["让总 agent 审查"]);
    expect(headerActions(card("todo")).map((a) => a.label)).toEqual(["立即执行"]);
    expect(headerActions(card("in_progress"))).toEqual([]);
    expect(headerActions(card("done"))).toEqual([]);
  });
});

describe("timeline descriptions", () => {
  it("describes chat and proposal events in one line", () => {
    expect(describeEvent(chatEv("master", { text: "你好" }))).toBe("[总 agent] 你好");
    expect(
      describeEvent(chatEv("master", { changes: {}, rationale: "更清晰", status: "accepted" }, "proposal")),
    ).toBe("修改建议（已采纳）：更清晰");
  });
});
