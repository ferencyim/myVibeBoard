// WP-105: the plan tab. 制定方案 runs the card's scout model (when picked) and then the card's
// planning model; the planner asks questions, takes change requests, overwrites the card's only
// plan and drafts the acceptance criteria (as a proposal once the owner edited them). Switching the
// planning model hands the conversation over. The master agent takes no part.

import { describe, expect, it } from "vitest";
import { createPlanning } from "../server/planning/planner";
import { PlanTurnSchema } from "../server/planning/schema";
import { messagesOf, threadState } from "../server/planning/thread";
import { createMasterRuntime } from "../server/runtime";
import type { MasterPaseo } from "../server/types";
import type { MemoryPort } from "../server/memory/files";
import { ManualClock, defaultSettings, fakePaseo, setupBoard, tempDir, type Script } from "./helpers";

const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const memory: MemoryPort = {
  snapshot: () => ({
    "PROJECT_STATE.md": [{ id: "m_1", tag: "", body: "State: login screen exists", touched: "" }],
    "DECISIONS.md": [],
    "LESSONS.md": [],
    "INDEX.md": [],
  }),
  apply: () => ({ stateWritten: false, added: 0, superseded: 0, archived: 0, duplicates: 0 }),
};

function setup(script: Script, options: { noPaseo?: boolean } = {}) {
  const board = setupBoard();
  const fake = fakePaseo(script);
  let paseo: MasterPaseo | null = options.noPaseo ? null : fake.paseo;
  const planning = createPlanning({
    db: board.db,
    store: board.store,
    getPaseo: () => paseo,
    dataDir: tempDir("vibe-master-data-"),
    clock: new ManualClock(),
    memory,
    enabled: () => true,
    log: () => undefined,
  });
  const say = (cardId: string, text: string) =>
    board.store.cards.addChat({ cardId, authorKind: "user", author: "user", text, thread: "plan" });
  const makePlan = (cardId: string) =>
    board.store.cards.addChat({
      cardId,
      authorKind: "user",
      author: "user",
      text: "请制定方案",
      thread: "plan",
      action: "make_plan",
    });
  const card = (title: string) => {
    const c = board.draft(title);
    return board.store.cards.update(c.id, { plannerPresetId: board.presets.claude.id });
  };
  const chats = (cardId: string) =>
    board.store.events.list(cardId).filter((e) => e.type === "chat").map((e) => ({
      author: e.authorKind,
      ...(e.body as { text: string; thread?: string; answers?: string[]; error?: boolean }),
    }));
  return {
    ...board,
    fake,
    planning,
    say,
    makePlan,
    card,
    chats,
    setPaseo(next: MasterPaseo | null) {
      paseo = next;
    },
  };
}

describe("plan thread", () => {
  it("only plan-thread owner messages are pending for the planner", () => {
    const t = setup(() => "");
    const c = t.card("Thread");
    const first = t.say(c.id, "hello");
    t.store.cards.addChat({
      cardId: c.id,
      authorKind: "master",
      author: "planner",
      text: "hi",
      thread: "plan",
      answers: [first.id],
    });
    const second = t.say(c.id, "more");
    t.store.cards.addChat({ cardId: c.id, authorKind: "user", text: "to the executor", thread: "exec" });
    const state = threadState(t.store.events.list(c.id));
    expect(state.pending.map((m) => m.id)).toEqual([second.id]);
    expect(messagesOf(t.store.events.list(c.id))).toHaveLength(3);
  });

  it("validates planner replies", () => {
    expect(PlanTurnSchema.safeParse({ reply: "ok" }).success).toBe(true);
    expect(PlanTurnSchema.safeParse({ reply: "" }).success).toBe(false);
    expect(PlanTurnSchema.safeParse({ reply: "x", research: Array(4).fill({ question: "q" }) }).success).toBe(
      false,
    );
    expect(PlanTurnSchema.safeParse({ reply: "x", plan: { text: "p" }, acceptance: "a" }).success).toBe(true);
  });
});

describe("制定方案", () => {
  it("scouts on the scout model first, then plans on the planning model in the repository, read-only", async () => {
    const t = setup(({ provider, prompt }) => {
      if (provider === "kimi") return "src/settings.ts holds the toggles";
      expect(prompt).toContain("[plan:start]");
      expect(prompt).toContain("## 探路结果");
      expect(prompt).toContain("src/settings.ts holds the toggles");
      return fence({
        reply: "方案已定，有一个问题：要不要跟随系统主题？",
        plan: { text: "在设置页加深色开关", files: ["src/settings/**"] },
        acceptance: "1. 开关切换主题\n2. 重启后保持",
      });
    });
    const c = t.card("Dark mode");
    t.store.cards.update(c.id, { scoutPresetId: t.presets.kimi.id });
    t.makePlan(c.id);
    await t.planning.tick();

    const scout = t.fake.agents.find((a) => a.provider === "kimi");
    const planner = t.fake.agents.find((a) => a.provider === "claude");
    // The scout answered before the planner got its first message.
    expect(scout!.prompts).toHaveLength(1);
    expect(scout!.provider).toBe("kimi");
    expect(scout!.options.labels).toMatchObject({ role: "scout" });
    expect(scout!.archived).toBe(true);
    expect(planner!.provider).toBe("claude");
    expect(planner!.options.cwd).toBe(t.repoPath);
    expect(planner!.options.config.modeId).toBe("plan");
    expect(String(planner!.options.config.provider)).toBe("claude/opus-x");
    expect(planner!.options.config.thinkingOptionId).toBe("high");
    expect(String(planner!.options.config.systemPrompt)).toContain("规划会话");

    const now = t.store.cards.get(c.id)!;
    expect(now.plan?.description).toBe("在设置页加深色开关");
    expect(now.plan?.files).toEqual(["src/settings/**"]);
    expect(now.acceptance).toBe("1. 开关切换主题\n2. 重启后保持");
    const chats = t.chats(c.id);
    expect(chats.map((m) => m.author)).toEqual(["user", "scout", "master"]);
    expect(chats.every((m) => m.thread === "plan")).toBe(true);
    expect(chats[2]!.text).toContain("要不要跟随系统主题");
    // The owner sees the new content as unread in the plan tab.
    expect(now.planActivityAt).not.toBeNull();
  });

  it("without a scout model it plans directly; without a planning model it says so", async () => {
    const t = setup(() => fence({ reply: "ok", plan: { text: "p" } }));
    const c = t.card("No scout");
    t.makePlan(c.id);
    await t.planning.tick();
    expect(t.fake.agents.map((a) => a.provider)).toEqual(["claude"]);

    const bare = t.draft("No planner");
    t.makePlan(bare.id);
    await t.planning.tick();
    const reply = t.chats(bare.id).at(-1)!;
    expect(reply.author).toBe("master");
    expect(reply.error).toBe(true);
    expect(reply.text).toContain("还没有规划模型");
    expect(t.fake.agents).toHaveLength(1);
  });

  it("answers, change requests and re-planning overwrite the single plan", async () => {
    let n = 0;
    const t = setup(({ prompt }) => {
      n++;
      if (n === 1) return fence({ reply: "跟随系统吗？", plan: { text: "v1" }, acceptance: "1. 能切换" });
      if (n === 2) {
        expect(prompt).toContain("[plan:turn]");
        expect(prompt).toContain("要跟随系统");
        return fence({ reply: "已改", plan: { text: "v2 跟随系统" }, acceptance: "1. 能切换\n2. 跟随系统" });
      }
      expect(prompt).toContain("[plan:start]"); // 制定方案 again: full context
      expect(prompt).toContain("v2 跟随系统");
      return fence({ reply: "重新制定", plan: { text: "v3" } });
    });
    const c = t.card("Answers");
    t.makePlan(c.id);
    await t.planning.tick();
    t.say(c.id, "要跟随系统");
    await t.planning.tick();
    expect(t.store.cards.get(c.id)!.plan?.description).toBe("v2 跟随系统");
    expect(t.store.cards.get(c.id)!.acceptance).toBe("1. 能切换\n2. 跟随系统");
    t.makePlan(c.id);
    await t.planning.tick();
    expect(t.store.cards.get(c.id)!.plan?.description).toBe("v3");
    expect(t.store.plans.list(c.id)).toEqual([]);
    expect(t.fake.agents).toHaveLength(1); // same planning session throughout
    const updates = t.store.events
      .list(c.id)
      .filter((e) => e.type === "note" && (e.body as { kind?: string }).kind === "plan_updated");
    expect(updates).toHaveLength(3);
  });

  it("criteria the owner edited are proposed in the plan chat, not overwritten", async () => {
    let n = 0;
    const t = setup(() =>
      ++n === 1
        ? fence({ reply: "初稿", plan: { text: "p" }, acceptance: "1. 模型写的" })
        : fence({ reply: "补了一条", acceptance: "1. 模型写的\n2. 新增" }),
    );
    const c = t.card("Owner edits");
    t.makePlan(c.id);
    await t.planning.tick();
    t.store.cards.update(c.id, { acceptance: "1. 我改过的" });
    t.say(c.id, "再补充一下验收标准");
    await t.planning.tick();
    expect(t.store.cards.get(c.id)!.acceptance).toBe("1. 我改过的");
    const proposal = t.store.events.list(c.id).find((e) => e.type === "proposal")!;
    expect(proposal.body).toMatchObject({ status: "pending", changes: { acceptance: "1. 模型写的\n2. 新增" } });
    expect(t.chats(c.id).at(-1)!.text).toContain("作为建议");
  });

  it("switching the planning model starts a new session that gets the conversation and the plan", async () => {
    const t = setup(({ provider, prompt }) => {
      if (provider === "claude") return fence({ reply: "第一版", plan: { text: "旧方案 A" }, acceptance: "1. a" });
      expect(prompt).toContain("[plan:start]");
      expect(prompt).toContain("旧方案 A");
      expect(prompt).toContain("1. a");
      expect(prompt).toContain("## 至今的方案对话");
      expect(prompt).toContain("第一版");
      expect(prompt).toContain("换个思路");
      return fence({ reply: "接着做", plan: { text: "新方案 B" } });
    });
    const c = t.card("Switch");
    t.makePlan(c.id);
    await t.planning.tick();
    t.store.cards.update(c.id, { plannerPresetId: t.presets.codex.id });
    t.say(c.id, "换个思路");
    await t.planning.tick();
    const [first, second] = t.fake.agents;
    expect(first!.archived).toBe(true);
    expect(second!.provider).toBe("codex");
    expect(t.store.sessions.list({ cardId: c.id, role: "planner" }).map((s) => s.state)).toEqual(["ended", "idle"]);
    expect(t.store.cards.get(c.id)!.plan?.description).toBe("新方案 B");
  });

  it("the planner asks the scout model for research during a turn", async () => {
    let n = 0;
    const t = setup(({ provider, prompt }) => {
      if (provider === "kimi") return "found it in src/x.ts";
      n++;
      if (n === 1) return fence({ reply: "先查一下", research: [{ question: "where is x?" }] });
      expect(prompt).toContain("[plan:research_results]");
      expect(prompt).toContain("found it in src/x.ts");
      return fence({ reply: "查到了", plan: { text: "改 src/x.ts" } });
    });
    const c = t.card("Research");
    t.store.cards.update(c.id, { scoutPresetId: t.presets.kimi.id });
    t.say(c.id, "怎么做？");
    await t.planning.tick();
    expect(t.chats(c.id).map((m) => m.author)).toEqual(["user", "scout", "master"]);
    expect(t.store.cards.get(c.id)!.plan?.description).toBe("改 src/x.ts");
  });

  it("parks a turn without a daemon handle and finishes it later; archives the planner when the card is done", async () => {
    const t = setup(() => fence({ reply: "ok", plan: { text: "p" } }), { noPaseo: true });
    const c = t.card("Later");
    t.makePlan(c.id);
    await t.planning.tick();
    expect(t.chats(c.id)).toHaveLength(1);
    t.setPaseo(t.fake.paseo);
    await t.planning.resume();
    expect(t.chats(c.id).at(-1)!.text).toBe("ok");

    t.db.prepare(`UPDATE card SET "column" = 'done' WHERE id = ?`).run(c.id);
    await t.planning.tick();
    expect(t.fake.agents[0]!.archived).toBe(true);
    expect(t.store.sessions.list({ cardId: c.id, role: "planner" })[0]!.state).toBe("ended");
  });
});

describe("the master is out of the card flow", () => {
  it("creating, editing, planning and finishing cards never wakes the master agent", async () => {
    const board = setupBoard();
    const fake = fakePaseo(({ prompt }) => {
      if (prompt.includes("[plan:")) return fence({ reply: "ok", plan: { text: "p" } });
      return fence({ summary: "nothing new" });
    });
    const runtime = createMasterRuntime({
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => defaultSettings(),
      dataDir: tempDir("vibe-master-data-"),
      clock: new ManualClock(),
      memory,
      pollIntervalMs: 5,
      log: () => undefined,
    });
    try {
      const c = board.draft("Flow");
      board.store.cards.update(c.id, { description: "edited", plannerPresetId: board.presets.codex.id });
      board.store.cards.addChat({ cardId: c.id, authorKind: "user", text: "制定", thread: "plan", action: "make_plan" });
      board.store.cards.move(c.id, { to: "todo", actor: "user" });
      await runtime.planning.tick();
      await new Promise((r) => setTimeout(r, 100));
      // Only the planner ran (on codex); no master agent, no evaluation, no suggested preset.
      expect(fake.agents.map((a) => a.options.labels?.role)).toEqual(["planner"]);
      expect(board.store.sessions.list({ role: "master" })).toHaveLength(0);
      expect(board.store.events.list(c.id).some((e) => e.type === "evaluation")).toBe(false);
      expect(board.store.cards.get(c.id)!.suggestedPresetId).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });
});

describe("subtasks in the plan (WP-106)", () => {
  const sub = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `任务 ${id}`,
    goal: "目标",
    method: "方法",
    notes: "注意",
    acceptance: "验收",
    files: [`src/${id}.ts`],
    ...extra,
  });

  it("rejects subtask lists with unknown dependencies or cycles", () => {
    const ok = PlanTurnSchema.safeParse({ reply: "x", plan: { text: "p", subtasks: [sub("s1"), sub("s2", { dependsOn: ["s1"] })] } });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.plan?.subtasks?.[0]?.dependsOn).toEqual([]);
    expect(PlanTurnSchema.safeParse({ reply: "x", plan: { text: "p", subtasks: [sub("s1", { dependsOn: ["s9"] })] } }).success).toBe(false);
    expect(
      PlanTurnSchema.safeParse({
        reply: "x",
        plan: { text: "p", subtasks: [sub("s1", { dependsOn: ["s2"] }), sub("s2", { dependsOn: ["s1"] })] },
      }).success,
    ).toBe(false);
  });

  it("writes the planner's subtasks (preset names -> ids); after the owner's edit they become a proposal", async () => {
    let n = 0;
    const t = setup(({ prompt }) => {
      n++;
      if (n === 1) {
        return fence({
          reply: "拆成两个子任务",
          plan: { text: "v1", subtasks: [sub("s1", { preset: t.presets.kimi.name }), sub("s2", { dependsOn: ["s1"], preset: "不存在" })] },
        });
      }
      // The planner sees the current subtasks (the owner's version) as JSON.
      expect(prompt).toContain("负责人改过子任务");
      return fence({ reply: "改了", plan: { text: "v2", subtasks: [sub("s1")] } });
    });
    const c = t.card("Split");
    t.makePlan(c.id);
    await t.planning.tick();
    const first = t.store.cards.get(c.id)!;
    expect(first.plan?.subtasks?.map((s) => [s.id, s.presetId])).toEqual([
      ["s1", t.presets.kimi.id],
      ["s2", null],
    ]);

    t.store.cards.setSubtasks(c.id, [...first.plan!.subtasks!, { ...sub("s3"), dependsOn: [], presetId: null }]);
    t.makePlan(c.id);
    await t.planning.tick();
    const second = t.store.cards.get(c.id)!;
    expect(second.plan?.description).toBe("v2");
    expect(second.plan?.subtasks?.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    const proposal = t.store.events.list(c.id).find((e) => e.type === "proposal")!;
    expect((proposal.body as { changes: { subtasks: Array<{ id: string }> } }).changes.subtasks.map((s) => s.id)).toEqual(["s1"]);
    expect(t.chats(c.id).at(-1)!.text).toContain("你改过子任务");
  });
});

describe("复核方案 (WP-108)", () => {
  const oldPlan = { description: "旧方案：直接改表", checks: [], subCards: [], tags: [], recommendedPresetId: null };
  const reviewPlan = (t: ReturnType<typeof setup>, cardId: string) =>
    t.store.cards.addChat({ cardId, authorKind: "user", author: "user", text: "请复核方案。", thread: "plan", action: "review_plan" });

  it("the plan reviewer's opinion goes to the plan conversation, then the planning model revises the plan", async () => {
    const t = setup(({ provider, prompt }) => {
      if (provider === "kimi") {
        expect(prompt).toContain("方案复核模型");
        expect(prompt).toContain("旧方案：直接改表");
        return "需要修改：缺少回滚步骤";
      }
      expect(prompt).toContain("[plan:review]");
      expect(prompt).toContain("缺少回滚步骤");
      return fence({ reply: "已按复核意见补上回滚步骤", plan: { text: "新方案：先备份，可回滚" } });
    });
    const c = t.card("Migrate");
    t.store.cards.setPlan(c.id, { plan: oldPlan });
    // No pick on the card: the global default plan reviewer is used.
    t.store.modelDefaults.setGlobal({ plan_reviewer: t.presets.kimi.id });
    reviewPlan(t, c.id);
    await t.planning.tick();

    const reviewer = t.fake.agents.find((a) => a.provider === "kimi")!;
    expect(reviewer.options.labels).toMatchObject({ role: "plan_reviewer" });
    expect(reviewer.options.cwd).toBe(t.repoPath);
    expect(reviewer.archived).toBe(true);
    expect(t.store.cards.get(c.id)!.plan?.description).toBe("新方案：先备份，可回滚");
    const chats = t.chats(c.id);
    expect(chats.map((m) => m.author)).toEqual(["user", "reviewer", "master"]);
    expect(chats[1]).toMatchObject({ thread: "plan", text: "需要修改：缺少回滚步骤" });
    expect(chats[2]!.text).toContain("已按复核意见");
    expect(threadState(t.store.events.list(c.id)).pending).toEqual([]);
  });

  it("can be repeated; each review is answered on its own", async () => {
    let reviews = 0;
    const t = setup(({ provider }) => {
      if (provider === "kimi") return `意见 ${++reviews}`;
      return fence({ reply: `已改 ${reviews}`, plan: { text: `方案 v${reviews + 1}` } });
    });
    const c = t.card("Repeat");
    t.store.cards.update(c.id, { planReviewerPresetId: t.presets.kimi.id });
    t.store.cards.setPlan(c.id, { plan: oldPlan });
    reviewPlan(t, c.id);
    await t.planning.tick();
    reviewPlan(t, c.id);
    await t.planning.tick();
    expect(t.store.cards.get(c.id)!.plan?.description).toBe("方案 v3");
    expect(t.chats(c.id).filter((m) => m.author === "reviewer").map((m) => m.text)).toEqual(["意见 1", "意见 2"]);
  });

  it("without a plan or a plan reviewer it says so; the planning model may come from the project default", async () => {
    const t = setup(() => fence({ reply: "ok" }));
    const bare = t.draft("Defaults");
    t.store.projects.update(t.project.id, { defaultPresets: { planner: t.presets.claude.id } });
    reviewPlan(t, bare.id);
    await t.planning.tick();
    expect(t.chats(bare.id).at(-1)).toMatchObject({ author: "master", error: true, text: expect.stringContaining("还没有方案") });
    t.store.cards.setPlan(bare.id, { plan: oldPlan });
    reviewPlan(t, bare.id);
    await t.planning.tick();
    expect(t.chats(bare.id).at(-1)).toMatchObject({ error: true, text: expect.stringContaining("还没有方案复核模型") });
    expect(t.fake.agents).toHaveLength(0);
  });
});
