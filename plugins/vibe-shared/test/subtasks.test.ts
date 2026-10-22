// WP-106: subtasks in the plan, their runs, the sub-agent role and the scheduler limits.

import { describe, expect, it } from "vitest";
import {
  concurrencyBlock,
  emptyRun,
  subtaskListError,
  subtaskStartBlock,
  subtasksBusy,
} from "../contract/subtasks";
import type { CardView, PlanSnapshot, Subtask, SubtaskRun } from "../contract/model";
import { MIGRATIONS, migrateAll } from "../db";
import { openTestDb, setup } from "./helpers";

const st = (id: string, over: Partial<Subtask> = {}): Subtask => ({
  id,
  title: `任务 ${id}`,
  goal: "目标",
  method: "方法",
  notes: "",
  acceptance: "能用",
  files: [],
  dependsOn: [],
  presetId: null,
  ...over,
});

const plan = (subtasks?: Subtask[], text = "方案"): PlanSnapshot => ({
  description: text,
  checks: [],
  subCards: [],
  tags: [],
  recommendedPresetId: null,
  ...(subtasks ? { subtasks } : {}),
});

const run = (status: SubtaskRun["status"], over: Partial<SubtaskRun> = {}): SubtaskRun => ({
  ...emptyRun(),
  status,
  ...over,
});

const cardWith = (subtasks: Subtask[], runs: Record<string, SubtaskRun> = {}) =>
  ({ plan: plan(subtasks), subtaskRuns: runs }) as Pick<CardView, "plan" | "subtaskRuns">;

function seed() {
  const s = setup();
  const p = s.store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "<repo>" });
  const card = s.store.cards.create({ projectId: p.id, title: "t", description: "d" });
  return { ...s, p, card };
}

describe("subtask rules", () => {
  it("validates ids, dependencies and cycles", () => {
    expect(subtaskListError([st("s1"), st("s2", { dependsOn: ["s1"] })])).toBeNull();
    expect(subtaskListError([st("s1"), st("s1")])).toContain("重复");
    expect(subtaskListError([st("s1", { dependsOn: ["s9"] })])).toContain("不存在");
    expect(subtaskListError([st("s1", { dependsOn: ["s1"] })])).toContain("自己");
    expect(
      subtaskListError([st("s1", { dependsOn: ["s3"] }), st("s2", { dependsOn: ["s1"] }), st("s3", { dependsOn: ["s2"] })]),
    ).toContain("成环");
  });

  it("refuses to start: unknown, already running, unfinished dependency, overlapping files", () => {
    const list = [
      st("s1", { files: ["src/a/**"] }),
      st("s2", { files: ["src/a/x.ts"] }),
      st("s3", { files: ["src/b.ts"], dependsOn: ["s1"] }),
      st("s4", { files: [] }),
    ];
    expect(subtaskStartBlock(cardWith(list), "s9")).toContain("没有子任务 s9");
    expect(subtaskStartBlock(cardWith(list), "s1")).toBeNull();
    expect(subtaskStartBlock(cardWith(list), "s3")).toContain("s1 还没有完成");
    const busy = cardWith(list, { s1: run("running") });
    expect(subtaskStartBlock(busy, "s1")).toContain("已在运行");
    expect(subtaskStartBlock(busy, "s2")).toContain("相同的文件");
    expect(subtaskStartBlock(busy, "s4")).toBeNull(); // no files listed: never a conflict
    // A waiting (asking) sub-agent still holds its files; a done one releases them and unlocks s3.
    expect(subtaskStartBlock(cardWith(list, { s1: run("waiting") }), "s2")).toContain("相同的文件");
    const done = cardWith(list, { s1: run("done") });
    expect(subtaskStartBlock(done, "s2")).toBeNull();
    expect(subtaskStartBlock(done, "s3")).toBeNull();
    // A failed subtask may be started again.
    expect(subtaskStartBlock(cardWith(list, { s1: run("failed") }), "s1")).toBeNull();
  });

  it("is busy while a sub-agent runs, asks, or the main agent has not heard about a change", () => {
    expect(subtasksBusy({ subtaskRuns: {} })).toBe(false);
    expect(subtasksBusy({ subtaskRuns: { s1: run("running") } })).toBe(true);
    expect(subtasksBusy({ subtaskRuns: { s1: run("waiting") } })).toBe(true);
    expect(subtasksBusy({ subtaskRuns: { s1: run("done", { notified: false }) } })).toBe(true);
    expect(subtasksBusy({ subtaskRuns: { s1: run("done"), s2: run("failed") } })).toBe(false);
  });

  it("counts every running executor against the global, provider and project limits", () => {
    const limits = { globalLimit: 3, providerLimits: { codex: 1 } };
    const active = [
      { provider: "claude", projectId: "p1" },
      { provider: "codex", projectId: "p2" },
    ];
    const ask = (provider: string, projectId: string, projectLimit: number | null = null) =>
      concurrencyBlock({ limits, active, provider, projectId, projectLimit });
    expect(ask("claude", "p1")).toBeNull();
    expect(ask("codex", "p1")).toContain("codex 已达并发上限 1");
    expect(ask("claude", "p1", 1)).toContain("项目已达并发上限 1");
    expect(concurrencyBlock({ limits, active: [...active, active[0]!], provider: "x", projectId: "p3", projectLimit: null })).toContain(
      "全局并发上限 3",
    );
  });
});

describe("sub_agents migration", () => {
  it("adds the card columns and keeps sessions while allowing the subagent role", () => {
    const { db } = openTestDb();
    db.exec(
      "CREATE TABLE schema_version (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))",
    );
    for (const m of MIGRATIONS.core.filter((m) => m.version < 8)) {
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
      db.exec(m.sql);
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'x')").run(m.version);
    }
    db.exec(`
      INSERT INTO project (id, name, prefix, repo_path, project_type, created_at, updated_at)
        VALUES ('pr1','A','AA','/r','web','t','t');
      INSERT INTO card (id, project_id, number, key, title, sort_key, created_at, updated_at)
        VALUES ('c1','pr1',1,'AA-1','t','a','t','t');
      INSERT INTO agent_session (id, card_id, agent_id, role, current_provider, state, last_activity_at, started_at, complexity)
        VALUES ('s1','c1','a1','worker','claude','idle','t','t','short');
    `);
    expect(() =>
      db.exec(
        "INSERT INTO agent_session (id, card_id, agent_id, role, current_provider, last_activity_at, started_at) VALUES ('s0','c1','a0','subagent','x','t','t')",
      ),
    ).toThrow();
    migrateAll(db);
    expect(db.prepare("SELECT subagent_preset_id AS p, subtask_runs_json AS r FROM card").get()).toEqual({ p: null, r: "{}" });
    expect(db.prepare("SELECT id, role, state, complexity FROM agent_session").all()).toEqual([
      { id: "s1", role: "worker", state: "idle", complexity: "short" },
    ]);
    db.exec(
      "INSERT INTO agent_session (id, card_id, agent_id, role, current_provider, last_activity_at, started_at) VALUES ('s2','c1','a2','subagent','x','t','t')",
    );
    // Indexes are back (unique agent id).
    expect(() =>
      db.exec(
        "INSERT INTO agent_session (id, card_id, agent_id, role, current_provider, last_activity_at, started_at) VALUES ('s3','c1','a2','subagent','x','t','t')",
      ),
    ).toThrow();
    // The card cascade still works.
    db.exec("DELETE FROM card WHERE id = 'c1'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_session").get()).toEqual({ n: 0 });
  });
});

describe("subtasks on the card", () => {
  it("the model writes subtasks; once the owner edits them, the model's next version is a proposal", () => {
    const { store, card, tick } = seed();
    const preset = store.presets.create({ name: "Cheap", provider: "claude", model: "haiku" });
    const a = store.cards.setPlan(card.id, { plan: plan([st("s1"), st("s2", { dependsOn: ["s1"] })]) });
    expect(a.subtasks).toBe("applied");
    expect(a.card.plan?.subtasks?.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(a.card.plan?.subtasksEdited).toBeUndefined();

    // The owner picks a model for s2 and adds s3.
    tick();
    const mine = [st("s1"), st("s2", { dependsOn: ["s1"], presetId: preset.id }), st("s3")];
    const edited = store.cards.setSubtasks(card.id, mine);
    expect(edited.plan?.subtasksEdited).toBe(true);
    expect(edited.plan?.description).toBe("方案");
    expect(() => store.cards.setSubtasks(card.id, [st("s1", { dependsOn: ["s1"] })])).toThrow(/自己/);
    expect(() => store.cards.setSubtasks(card.id, [st("s1", { presetId: "nope" })])).toThrow();

    // The model revises: plan text is applied, the owner's subtasks stay, the model's wait as a proposal.
    tick();
    const b = store.cards.setPlan(card.id, { plan: plan([st("s1", { title: "新" })], "方案 2") });
    expect(b.subtasks).toBe("proposed");
    expect(b.card.plan?.description).toBe("方案 2");
    expect(b.card.plan?.subtasks).toEqual(mine);
    const proposal = store.events.list(card.id).find((e) => e.type === "proposal")!;
    const body = proposal.body as { changes: { subtasks: Subtask[] }; before: { subtasks: Subtask[] } };
    expect(body.changes.subtasks.map((s) => s.title)).toEqual(["新"]);
    expect(body.before.subtasks).toEqual(mine);
    // Same subtasks again: no second proposal.
    store.cards.setPlan(card.id, { plan: plan([st("s1", { title: "新" })], "方案 2") });
    expect(store.events.list(card.id).filter((e) => e.type === "proposal")).toHaveLength(1);

    // Accepting applies them and the model may overwrite directly again.
    store.cards.acceptProposal(proposal.id, "user");
    const accepted = store.cards.get(card.id)!;
    expect(accepted.plan?.subtasks?.map((s) => s.title)).toEqual(["新"]);
    expect(accepted.plan?.subtasksEdited).toBeUndefined();
    tick();
    const c = store.cards.setPlan(card.id, { plan: plan([st("s9")], "方案 3") });
    expect(c.subtasks).toBe("applied");
    expect(c.card.plan?.subtasks?.map((s) => s.id)).toEqual(["s9"]);
  });

  it("rejects an invalid subtask list from the model", () => {
    const { store, card } = seed();
    expect(() => store.cards.setPlan(card.id, { plan: plan([st("s1", { dependsOn: ["s2"] })]) })).toThrow(/不存在/);
  });

  it("subtasks can be edited before any plan exists", () => {
    const { store, card } = seed();
    const c = store.cards.setSubtasks(card.id, [st("s1")]);
    expect(c.plan?.description).toBe("");
    expect(c.plan?.subtasks).toHaveLength(1);
  });

  it("keeps a run per subtask and a sub-agent default model on the card", () => {
    const { store, card } = seed();
    const preset = store.presets.create({ name: "Cheap", provider: "claude", model: "haiku" });
    expect(store.cards.update(card.id, { subagentPresetId: preset.id }).subagentPresetId).toBe(preset.id);
    const r = store.cards.setSubtaskRun(card.id, "s1", { status: "running", sessionId: "x", attempts: 1, notified: false });
    expect(r).toMatchObject({ status: "running", sessionId: "x", attempts: 1, notified: false, summary: "" });
    store.cards.setSubtaskRun(card.id, "s1", { status: "done", summary: "好了" });
    expect(store.cards.get(card.id)!.subtaskRuns.s1).toMatchObject({ status: "done", summary: "好了", sessionId: "x" });
  });

  it("a sub-agent replacement keeps the card's main model", () => {
    const { store, card } = seed();
    const main = store.presets.create({ name: "Main", provider: "claude", model: "opus" });
    const other = store.presets.create({ name: "Other", provider: "codex", model: "m" });
    store.cards.update(card.id, { presetId: main.id });
    const sub = store.sessions.start({ cardId: card.id, agentId: "a1", role: "subagent", provider: "claude" });
    const { to } = store.sessions.recordReassign({
      fromSessionId: sub.id,
      agentId: "a2",
      provider: "codex",
      reason: "quota",
      presetId: other.id,
    });
    expect(to.role).toBe("subagent");
    expect(store.cards.get(card.id)!.presetId).toBe(main.id);
  });

  it("scheduler limits: defaults until published", () => {
    const { store } = seed();
    expect(store.limits.get()).toEqual({ globalLimit: 4, providerLimits: {} });
    store.limits.publish({ globalLimit: 2, providerLimits: { codex: 1 } });
    expect(store.limits.get()).toEqual({ globalLimit: 2, providerLimits: { codex: 1 } });
  });
});

describe("concurrency slots", () => {
  it("a main agent holds its slot until it ends; a sub-agent only while it works or asks", async () => {
    const { takesSlot } = await import("../contract/subtasks");
    expect(takesSlot({ role: "worker", state: "idle" })).toBe(true);
    expect(takesSlot({ role: "subagent", state: "working" })).toBe(true);
    expect(takesSlot({ role: "subagent", state: "waiting" })).toBe(true);
    expect(takesSlot({ role: "subagent", state: "idle" })).toBe(false);
    expect(takesSlot({ role: "planner", state: "working" })).toBe(false);
  });
});
