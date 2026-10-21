import { describe, expect, it } from "vitest";
import { findOverlap, globsOverlap } from "../server/overlap";
import { setup } from "./helpers";

const plan = (files?: string[]) => ({
  description: "",
  checks: [],
  subCards: [],
  tags: [],
  recommendedPresetId: null,
  files,
});

describe("globsOverlap", () => {
  it.each([
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/**", "src/deep/x.ts", true],
    ["src/**", "lib/**", false],
    ["src/app", "src/app/a.ts", true], // a directory contains its files
    ["src/app/*.ts", "src/app/a.ts", true],
    ["src/app/*.ts", "src/app/a.tsx", false],
    ["src/*.ts", "src/*.test.ts", true],
    ["src/*.ts", "src/*.css", false],
    ["**/*.md", "docs/readme.md", true],
    ["**/*.md", "docs/readme.txt", false],
    ["packages\\app\\**","./packages/app/x.ts", true],
    ["**", "anything/at/all", true],
    ["src/**/util.ts", "src/a/b/util.ts", true],
    ["src/**/util.ts", "src/a/b/other.ts", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });

  it("findOverlap returns the offending pair and ignores empty lists", () => {
    expect(findOverlap(["a/**", "b/x.ts"], ["c/**", "b/*.ts"])).toEqual(["b/x.ts", "b/*.ts"]);
    expect(findOverlap([], ["a"])).toBeNull();
    expect(findOverlap(undefined, ["a"])).toBeNull();
  });
});

describe("conflict avoidance in the scheduler", () => {
  async function twoCards(aFiles: string[] | undefined, bFiles: string[] | undefined, settings = {}) {
    const t = setup({ settings });
    const p = t.preset("claude");
    const a = t.card("a", "medium", p.id);
    t.store.plans.save(a.id, plan(aFiles));
    t.store.cards.dispatch({ cardId: a.id, agentId: "ag1", provider: "claude", worktree: null, presetId: p.id });
    const b = t.card("b", "medium", p.id);
    t.store.plans.save(b.id, plan(bFiles));
    return { t, a, b, r: await t.runtime.tickOnce() };
  }

  it("defers a card whose files overlap a running card and says why", async () => {
    const { a, r, t } = await twoCards(["src/app/**"], ["src/app/main.ts"]);
    expect(r.admitted).toHaveLength(0);
    expect(r.deferred["DEMO-2"]).toBe(`与 ${a.key} 改动相同的文件，等它结束`);
    expect(t.runtime.scheduler.status().deferred["DEMO-2"]).toMatch(/与 DEMO-1 改动相同的文件/);
  });

  it("admits when files are disjoint, or when either side declares none", async () => {
    expect((await twoCards(["src/a/**"], ["src/b/**"])).r.admitted).toHaveLength(1);
    expect((await twoCards(undefined, ["src/b/**"])).r.admitted).toHaveLength(1);
    expect((await twoCards(["src/a/**"], undefined)).r.admitted).toHaveLength(1);
  });

  it("can be switched off", async () => {
    const { r } = await twoCards(["src/**"], ["src/x.ts"], { conflictAvoidance: false });
    expect(r.admitted).toHaveLength(1);
  });

  it("also holds back the second of two overlapping todo cards admitted in the same tick", async () => {
    const t = setup();
    const p = t.preset("claude");
    for (const title of ["a", "b"]) {
      const c = t.card(title, "medium", p.id);
      t.store.plans.save(c.id, plan(["src/**"]));
    }
    const r = await t.runtime.tickOnce();
    expect(r.admitted.map((x) => x.cardKey)).toEqual(["DEMO-1"]);
    expect(r.deferred["DEMO-2"]).toMatch(/与 DEMO-1 改动相同的文件/);
  });

  it("uses the latest plan version only", async () => {
    const t = setup();
    const p = t.preset("claude");
    const a = t.card("a", "medium", p.id);
    t.store.plans.save(a.id, plan(["src/**"]));
    t.store.plans.save(a.id, plan(["docs/**"]));
    t.store.cards.dispatch({ cardId: a.id, agentId: "ag1", provider: "claude", worktree: null, presetId: p.id });
    const b = t.card("b", "medium", p.id);
    t.store.plans.save(b.id, plan(["src/x.ts"]));
    expect((await t.runtime.tickOnce()).admitted).toHaveLength(1);
  });

  it("a manual dispatch bypasses the scheduler entirely", () => {
    const t = setup();
    const p = t.preset("claude");
    const a = t.card("a", "medium", p.id);
    t.store.plans.save(a.id, plan(["src/**"]));
    t.store.cards.dispatch({ cardId: a.id, agentId: "ag1", provider: "claude", worktree: null, presetId: p.id });
    const b = t.card("b", "medium", p.id);
    t.store.plans.save(b.id, plan(["src/**"]));
    // The user's "dispatch" button calls the store directly; no tick, no conflict check.
    expect(() =>
      t.store.cards.dispatch({ cardId: b.id, agentId: "ag2", provider: "claude", worktree: null, presetId: p.id }),
    ).not.toThrow();
    expect(t.store.cards.get(b.id)?.column).toBe("in_progress");
  });
});
