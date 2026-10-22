// WP-105: single plan on the card, acceptance edits by the owner, chat threads and unread markers.

import { describe, expect, it } from "vitest";
import {
  activityTabsOf,
  chatThreadOf,
  isTabUnread,
  markReadPatch,
  unreadTabsOf,
} from "../contract/card-tabs";
import type { CardEvent, PlanSnapshot } from "../contract/model";
import { MIGRATIONS, migrateAll, readEvents } from "../db";
import { openTestDb, setup } from "./helpers";

const plan = (text: string, files: string[] = []): PlanSnapshot => ({
  description: text,
  checks: [],
  subCards: [],
  tags: [],
  recommendedPresetId: null,
  files,
});

function seed() {
  const s = setup();
  const p = s.store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "<repo>" });
  const card = s.store.cards.create({ projectId: p.id, title: "t", description: "d" });
  return { ...s, p, card };
}

const ev = (over: Partial<CardEvent>): CardEvent => ({
  id: "e",
  cardId: "c",
  type: "chat",
  authorKind: "master",
  author: "",
  body: { text: "x" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedHlc: "",
  ...over,
});

describe("card_tabs migration", () => {
  it("adds the columns and keeps the newest plan version as the card's plan", () => {
    const { db } = openTestDb();
    db.exec(
      "CREATE TABLE schema_version (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))",
    );
    const before = MIGRATIONS.core.filter((m) => m.version < 7);
    for (const m of before) {
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
      db.exec(m.sql);
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'x')").run(m.version);
    }
    db.exec(`
      INSERT INTO project (id, name, prefix, repo_path, project_type, created_at, updated_at)
        VALUES ('pr1','A','AA','/r','web','t','t');
      INSERT INTO card (id, project_id, number, key, title, sort_key, created_at, updated_at)
        VALUES ('c1','pr1',1,'AA-1','t','a','t','t'), ('c2','pr1',2,'AA-2','u','b','t','t');
      INSERT INTO plan_version (id, card_id, version, snapshot_json, created_at)
        VALUES ('v1','c1',1,'{"description":"old","checks":[],"subCards":[],"tags":[],"recommendedPresetId":null}','t'),
               ('v2','c1',2,'{"description":"new","checks":[],"subCards":[],"tags":[],"recommendedPresetId":null}','t');
    `);
    migrateAll(db);
    const rows = db
      .prepare("SELECT id, json_extract(plan_json, '$.description') AS d, model_acceptance AS m FROM card ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "c1", d: "new", m: "" },
      { id: "c2", d: null, m: "" },
    ]);
  });
});

describe("cards.setPlan", () => {
  it("keeps one plan: re-planning overwrites it and the timeline records each change", () => {
    const { store, card, tick } = seed();
    const first = store.cards.setPlan(card.id, { plan: plan("v1", ["src/a.ts"]) });
    expect(first.planChanged).toBe(true);
    tick();
    store.cards.setPlan(card.id, { plan: plan("v2") });
    tick();
    const same = store.cards.setPlan(card.id, { plan: plan("v2") });
    expect(same.planChanged).toBe(false);
    const now = store.cards.get(card.id)!;
    expect(now.plan?.description).toBe("v2");
    expect(store.plans.list(card.id)).toEqual([]); // no version history any more
    const notes = store.events
      .list(card.id)
      .filter((e) => e.type === "note" && (e.body as { kind?: string }).kind === "plan_updated");
    expect(notes).toHaveLength(2);
  });

  it("writes model criteria directly, but proposes when the owner edited them", () => {
    const { store, card, tick } = seed();
    const a = store.cards.setPlan(card.id, { plan: plan("p"), acceptance: "1. 能登录" });
    expect(a.acceptance).toBe("applied");
    expect(a.card.acceptance).toBe("1. 能登录");
    expect(a.card.modelAcceptance).toBe("1. 能登录");

    // The model may revise its own text.
    tick();
    const b = store.cards.setPlan(card.id, { plan: plan("p"), acceptance: "1. 能登录\n2. 能退出" });
    expect(b.acceptance).toBe("applied");

    // The owner edits; the next model revision becomes a proposal and the card keeps the owner's text.
    tick();
    store.cards.update(card.id, { acceptance: "1. 能登录（手机）" });
    tick();
    const c = store.cards.setPlan(card.id, { plan: plan("p"), acceptance: "1. 能登录\n2. 能退出\n3. 有日志" });
    expect(c.acceptance).toBe("proposed");
    expect(c.card.acceptance).toBe("1. 能登录（手机）");
    const proposal = store.events.list(card.id).find((e) => e.type === "proposal")!;
    expect((proposal.body as { changes: { acceptance: string } }).changes.acceptance).toContain("有日志");
    // Same text again: no duplicate proposal.
    store.cards.setPlan(card.id, { plan: plan("p"), acceptance: "1. 能登录\n2. 能退出\n3. 有日志" });
    expect(store.events.list(card.id).filter((e) => e.type === "proposal")).toHaveLength(1);

    // Accepting makes it the model's text again: the following revision is applied directly.
    store.cards.acceptProposal(proposal.id, "user");
    tick();
    const d = store.cards.setPlan(card.id, { plan: plan("p"), acceptance: "4. 全部" });
    expect(d.acceptance).toBe("applied");
    expect(d.card.acceptance).toBe("4. 全部");
  });

  it("criteria typed by the owner before any plan are not overwritten either", () => {
    const { store, p } = seed();
    const card = store.cards.create({ projectId: p.id, title: "x", acceptance: "我写的" });
    const r = store.cards.setPlan(card.id, { plan: plan("p"), acceptance: "模型写的" });
    expect(r.acceptance).toBe("proposed");
    expect(r.card.acceptance).toBe("我写的");
  });
});

describe("chat threads and unread markers", () => {
  it("classifies chat rows written before WP-105 by author", () => {
    expect(chatThreadOf(ev({ authorKind: "executor" }))).toBe("exec");
    expect(chatThreadOf(ev({ authorKind: "reviewer" }))).toBe("review");
    expect(chatThreadOf(ev({ authorKind: "system", author: "dispatch" }))).toBe("exec");
    expect(chatThreadOf(ev({ authorKind: "master" }))).toBe("plan");
    expect(chatThreadOf(ev({ authorKind: "user" }))).toBe("plan");
    expect(chatThreadOf(ev({ authorKind: "user", body: { text: "x", thread: "exec" } }))).toBe("exec");
  });

  it("WP-108: review conclusions belong to the review tab, the plan reviewer to the plan conversation", () => {
    // Conclusions written before WP-108 said thread "exec".
    expect(chatThreadOf(ev({ authorKind: "reviewer", body: { text: "x", thread: "exec" } }))).toBe("review");
    expect(chatThreadOf(ev({ authorKind: "reviewer", body: { text: "x", thread: "review" } }))).toBe("review");
    expect(chatThreadOf(ev({ authorKind: "reviewer", body: { text: "x", thread: "plan" } }))).toBe("plan");
    expect(activityTabsOf(ev({ authorKind: "reviewer", body: { text: "x", thread: "plan" } }))).toEqual(["plan"]);
    expect(activityTabsOf(ev({ type: "reject", authorKind: "system", body: { text: "x", reviewReturn: true } }))).toEqual([
      "review",
      "verify",
    ]);
    expect(activityTabsOf(ev({ type: "reject", authorKind: "system", body: { text: "x" } }))).toEqual(["verify"]);
  });

  it("only other parties' content counts as new", () => {
    expect(activityTabsOf(ev({ authorKind: "user", body: { text: "x", thread: "plan" } }))).toEqual([]);
    expect(activityTabsOf(ev({ authorKind: "master", body: { text: "x", thread: "plan" } }))).toEqual(["plan"]);
    expect(activityTabsOf(ev({ authorKind: "executor", body: { text: "x", thread: "exec" } }))).toEqual(["exec"]);
    expect(activityTabsOf(ev({ authorKind: "reviewer" }))).toEqual(["review"]);
    expect(activityTabsOf(ev({ type: "proposal", authorKind: "master" }))).toEqual(["plan"]);
    expect(activityTabsOf(ev({ type: "status", authorKind: "system", body: { kind: "verification" } }))).toEqual([
      "verify",
    ]);
    expect(activityTabsOf(ev({ type: "status", authorKind: "system", body: { kind: "moved" } }))).toEqual([]);
  });

  it("stamps activity, counts unread per tab and clears it when the tab is read", () => {
    const { store, db, card, tick } = seed();
    expect(unreadTabsOf(store.cards.get(card.id)!)).toEqual([]);
    tick();
    store.cards.addChat({ cardId: card.id, authorKind: "user", text: "制定方案", thread: "plan" });
    expect(unreadTabsOf(store.cards.get(card.id)!)).toEqual([]);
    tick();
    store.cards.addChat({ cardId: card.id, authorKind: "master", text: "有个问题", thread: "plan" });
    tick();
    store.cards.addChat({ cardId: card.id, authorKind: "executor", text: "完成了", thread: "exec" });
    tick();
    store.events.add({
      cardId: card.id,
      type: "status",
      authorKind: "system",
      author: "verifier",
      body: { kind: "verification", conclusion: "pass" },
    });
    tick();
    store.cards.addChat({ cardId: card.id, authorKind: "reviewer", text: "复核通过", thread: "review", kind: "verdict" });
    let now = store.cards.get(card.id)!;
    expect(unreadTabsOf(now)).toEqual(["plan", "exec", "review", "verify"]);
    now = store.cards.update(card.id, markReadPatch(now, "review")!);
    expect(now.reviewSeenAt).toBe(now.reviewActivityAt);
    expect(unreadTabsOf(now)).toEqual(["plan", "exec", "verify"]);

    const before = now.updatedAt;
    const cursor = readEvents(db, 0, { limit: 1000 }).length;
    tick();
    now = store.cards.update(card.id, markReadPatch(now, "plan")!);
    expect(isTabUnread(now, "plan")).toBe(false);
    expect(unreadTabsOf(now)).toEqual(["exec", "verify"]);
    // Reading is not an edit: no updated_at bump, no card.updated event.
    expect(now.updatedAt).toBe(before);
    expect(readEvents(db, 0, { limit: 1000 }).length).toBe(cursor);
    expect(markReadPatch(now, "plan")).toBeNull();

    // New content after reading makes the tab unread again.
    tick();
    store.cards.setPlan(card.id, { plan: plan("p") });
    expect(isTabUnread(store.cards.get(card.id)!, "plan")).toBe(true);
  });
});
