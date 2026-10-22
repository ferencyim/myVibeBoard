import { beforeEach, describe, expect, it } from "vitest";
import { describeEvent } from "../client/detail/events";
import {
  canExecute,
  chatItemsOf,
  executingLabel,
  presetsFor,
  proposalDiff,
  reviewItemsOf,
  runningWorkerOf,
  waitingForReply,
  type MessageItem,
  type ProposalItem,
} from "../client/planning/logic";
import type { AgentSession, CardView, Preset } from "../shared/vibe/contract";
import { chatEv, resetEvents } from "./chat-helpers";

beforeEach(resetEvents);

const card = (column: CardView["column"], extra: Partial<CardView> = {}) =>
  ({ column, title: "T", description: "D", acceptance: "A", ...extra }) as CardView;
const sess = (role: string, state: string, extra: Partial<AgentSession> = {}) =>
  ({ role, state, ...extra }) as AgentSession;
const msgs = (items: ReturnType<typeof chatItemsOf>) =>
  items.filter((i): i is MessageItem => i.kind === "message");

describe("chatItemsOf", () => {
  it("labels authors, kinds and extras, and marks answered user messages", () => {
    const u1 = chatEv("user", { text: "hi", thread: "plan" });
    const m = chatEv("master", {
      text: "plan",
      thread: "plan",
      answers: [u1.id],
      kind: "summary",
      agentId: "ag1",
      detail: "long",
    });
    const u2 = chatEv("user", { text: "more", thread: "plan" });
    const sc = chatEv("scout", { text: "found", kind: "info", thread: "plan" });
    const items = msgs(chatItemsOf([u1, m, u2, sc], "plan"));
    expect(items.map((i) => i.label)).toEqual(["你", "规划模型", "你", "探路模型"]);
    expect(items.map((i) => i.answered)).toEqual([true, true, false, true]);
    expect(items[1]).toMatchObject({ msgKindLabel: "小结", agentId: "ag1", detail: "long" });
    expect(items[3]!.msgKindLabel).toBe("说明");
  });

  it("splits the two conversations by thread and classifies legacy rows", () => {
    const planUser = chatEv("user", { text: "plan talk", thread: "plan" });
    const execUser = chatEv("user", { text: "exec talk", thread: "exec" });
    const legacyUser = chatEv("user", { text: "old owner message" });
    const legacyMaster = chatEv("master", { text: "old master" });
    const legacyExecutor = chatEv("executor", { text: "old executor" });
    const legacyReviewer = chatEv("reviewer", { text: "old verdict", kind: "verdict", error: true });
    const legacyDispatch = chatEv("system", { text: "dispatched" });
    (legacyDispatch as { author: string }).author = "dispatch";
    const legacySystem = chatEv("system", { text: "plain system" });
    const events = [planUser, execUser, legacyUser, legacyMaster, legacyExecutor, legacyReviewer, legacyDispatch, legacySystem];
    const text = (thread: "plan" | "exec") =>
      chatItemsOf(events, thread).map((i) => (i.kind === "proposal" ? "proposal" : i.text));
    expect(text("plan")).toEqual(["plan talk", "old owner message", "old master", "plain system"]);
    expect(text("exec")).toEqual(["exec talk", "old executor", "old verdict", "dispatched"]);
    expect(msgs(chatItemsOf(events, "exec")).find((i) => i.author === "reviewer")).toMatchObject({
      msgKindLabel: "结论",
      error: true,
      label: "复核模型",
    });
  });

  it("derives system rows from status and reject events in the execution thread only", () => {
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
      chatEv("system", { text: "已转给执行 agent", kind: "info", thread: "exec" }),
    ];
    const items = chatItemsOf(events, "exec");
    expect(
      items.map((i) => (i.kind === "message" ? `m:${i.author}` : i.kind === "system" ? i.text : i.kind)),
    ).toEqual([
      "待办 → 进行中（派发）",
      "通过",
      "没有 agent",
      "已合并",
      "退回：测试没过",
      "已转给执行 agent",
    ]);
    expect(items[1]).toMatchObject({ link: "verification" });
    expect(chatItemsOf(events, "plan")).toEqual([]);
  });

  it("builds proposals (plan thread only) with status labels and diffs", () => {
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
    expect(chatItemsOf(events, "exec")).toEqual([]);
    const props = chatItemsOf(events, "plan") as ProposalItem[];
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

  it("reviewItemsOf lists only the reviewer's messages", () => {
    const events = [
      chatEv("executor", { text: "done", thread: "exec" }),
      chatEv("reviewer", { text: "fails", kind: "verdict", thread: "exec" }),
      chatEv("user", { text: "ok", thread: "exec" }),
      chatEv("reviewer", { text: "passes", kind: "verdict" }),
    ];
    expect(reviewItemsOf(events).map((i) => i.text)).toEqual(["fails", "passes"]);
    expect(reviewItemsOf([])).toEqual([]);
  });
});

describe("conversation state", () => {
  it("waitingForReply is true while an owner message has no answer", () => {
    const u = chatEv("user", { text: "q", thread: "plan" });
    expect(waitingForReply(chatItemsOf([u], "plan"))).toBe(true);
    const a = chatEv("master", { text: "a", thread: "plan", answers: [u.id] });
    expect(waitingForReply(chatItemsOf([u, a], "plan"))).toBe(false);
    expect(waitingForReply([])).toBe(false);
  });

  it("presetsFor filters by purpose; a preset without purposes fits every job", () => {
    const p = (id: string, roleHints: Preset["roleHints"]) => ({ id, roleHints }) as Preset;
    const all = [p("any", []), p("w", ["worker"]), p("r", ["reviewer"]), p("multi", ["scout", "worker"])];
    expect(presetsFor(all, "worker").map((x) => x.id)).toEqual(["any", "w", "multi"]);
    expect(presetsFor(all, "reviewer").map((x) => x.id)).toEqual(["any", "r"]);
    expect(presetsFor(all, "scout").map((x) => x.id)).toEqual(["any", "multi"]);
    expect(presetsFor([], "worker")).toEqual([]);
  });

  it("executingLabel names the running model, or nothing when no worker runs", () => {
    const preset = { id: "p1", name: "codex-high", provider: "codex", model: "gpt-5" } as Preset;
    const worker = sess("worker", "working", { currentProvider: "codex" });
    expect(executingLabel([worker], [preset], { presetId: "p1" })).toBe("codex-high（codex/gpt-5） · 执行中");
    // the card's preset no longer matches the provider that runs: show the provider
    expect(executingLabel([worker], [preset], { presetId: "other" })).toBe("codex · 执行中");
    expect(executingLabel([sess("worker", "waiting", { currentProvider: "codex" })], [preset], { presetId: "p1" })).toContain("等待你的回复");
    expect(executingLabel([sess("worker", "ended")], [preset], { presetId: "p1" })).toBeNull();
    expect(executingLabel([sess("planner", "working")], [preset], { presetId: "p1" })).toBeNull();
    expect(runningWorkerOf([sess("worker", "ended"), worker])).toBe(worker);
  });

  it("canExecute only for draft and todo cards", () => {
    expect(["draft", "todo"].every((c) => canExecute(card(c as never)))).toBe(true);
    expect(["in_progress", "verifying", "done"].some((c) => canExecute(card(c as never)))).toBe(false);
  });
});

describe("timeline descriptions", () => {
  it("describes chat and proposal events in one line", () => {
    expect(describeEvent(chatEv("master", { text: "你好" }))).toBe("[规划模型] 你好");
    expect(
      describeEvent(chatEv("master", { changes: {}, rationale: "更清晰", status: "accepted" }, "proposal")),
    ).toBe("修改建议（已采纳）：更清晰");
  });
});
