import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FixLauncher, SubAgentRunner } from "../server/types";
import { DAY, commit, setup, sh } from "./helpers";

const hasEvent = (h: ReturnType<typeof setup>, type: string) => h.events(type).length;

describe("workload trigger -> git health draft card (WP-36 acceptance)", () => {
  it("files exactly one low-priority draft card after 10 completed cards", async () => {
    const h = setup();
    await h.engine.tick(); // syncs the built-in rule
    h.complete(9);
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(0);

    // make the repository untidy so the check has something to say
    sh(h.repo, ["branch", "feat/finished"]); // merged into main but never deleted
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    h.complete(1);
    h.clock.advance(60_000);
    await h.engine.tick();

    const cards = h.maintenanceCards();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({
      column: "draft",
      origin: "maintenance",
      priority: "low",
      dedupeKey: "git-health",
    });
    expect(card.title).toMatch(/^Git 体检/);
    expect(card.originRef).toBe(`${h.project.id}:git-health`);

    const events = h.store.events.list(card.id).filter((e) => e.type === "maintenance");
    expect(events).toHaveLength(1);
    expect((events[0]!.body as { findings: unknown[] }).findings.length).toBeGreaterThan(0);

    const runs = h.engine.listRuns(card.originRef!);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "done", cardIds: [card.id] });
    expect(hasEvent(h, "maintenance.triggered")).toBe(1);
    // the counters restarted
    expect(h.engine.status().rules[0]!.counters.cards).toBe(0);
  });

  it("does not lose cards completed before the first tick of a new project", async () => {
    const h = setup();
    sh(h.repo, ["branch", "feat/finished"]);
    h.complete(10); // no tick yet: the rules do not exist
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(1);
  });

  it("appends a record instead of a new card while the dedupe key has an open card", async () => {
    const h = setup();
    await h.engine.tick();
    commit(h.repo, "x.txt", "x\n", "x"); // keeps `main` ahead of nothing but dirties nothing; add dirt below
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    h.complete(10);
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(1);
    const cardId = h.maintenanceCards()[0]!.id;

    h.clock.advance(DAY); // a new day: the daily cap is not in the way
    h.complete(10);
    await h.engine.tick();

    expect(h.maintenanceCards()).toHaveLength(1);
    const notes = h.store.events.list(cardId).filter((e) => e.type === "maintenance");
    expect(notes.map((e) => (e.body as { kind: string }).kind)).toEqual(["created", "recurrence"]);
    expect(h.engine.listRuns(`${h.project.id}:git-health`)).toHaveLength(2);
  });

  it("honours the daily cap and fires again the next day", async () => {
    const h = setup({
      yml: `rules:
  - name: git-health
    trigger: { kind: workload, cards_done: 2 }
    check: { type: git, outdated: false }
    daily_cap: 1
`,
    });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(2);
    await h.engine.tick();
    expect(h.engine.listRuns(`${h.project.id}:git-health`)).toHaveLength(1);

    h.complete(2);
    await h.engine.tick();
    expect(h.engine.listRuns(`${h.project.id}:git-health`)).toHaveLength(1);
    const view = h.engine.status().rules[0]!;
    expect(view.blocked).toBe("daily_cap");
    expect(view.counters.cards).toBe(2); // not lost, just waiting

    h.clock.advance(DAY);
    await h.engine.tick();
    expect(h.engine.listRuns(`${h.project.id}:git-health`)).toHaveLength(2);
  });

  it("does not file a card when the check finds nothing", async () => {
    const h = setup({
      yml: `rules:
  - name: git-health
    trigger: { kind: workload, cards_done: 1 }
    check: { type: git, outdated: false }
`,
    });
    // .vibe/maintenance.yml itself is untracked: commit it so the repository is tidy
    sh(h.repo, ["add", "-A"]);
    sh(h.repo, ["commit", "-m", "add rules"]);
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(0);
    const run = h.engine.listRuns(`${h.project.id}:git-health`)[0]!;
    expect(run).toMatchObject({ status: "done", cardIds: [] });
  });

  it("fires on merged commits (git rev-list since the last trigger)", async () => {
    const h = setup({
      yml: `rules:
  - name: commit-watch
    trigger: { kind: workload, commits_merged: 4 }
    check: { type: git, outdated: false }
    dedupe_key: commit-watch
`,
      engine: { commitPollSeconds: 0 },
    });
    await h.engine.tick();
    commit(h.repo, "a.txt", "a\n", "a");
    commit(h.repo, "b.txt", "b\n", "b");
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(0);
    commit(h.repo, "c.txt", "c\n", "c");
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(1);
  });
});

describe("auto pause after consecutive rejections", () => {
  const yml = `rules:
  - name: git-health
    trigger: { kind: workload, cards_done: 1 }
    check: { type: git, outdated: false }
`;

  it("pauses the rule, announces it, and resumes on request", async () => {
    const h = setup({ yml });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    const ruleId = `${h.project.id}:git-health`;

    for (let day = 0; day < 3; day++) {
      h.complete(1);
      await h.engine.tick();
      const open = h.maintenanceCards().filter((c) => !c.archivedAt);
      expect(open).toHaveLength(1);
      h.store.cards.archive(open[0]!.id); // the user rejects the suggestion
      await h.engine.tick();
      h.clock.advance(DAY);
    }

    const rule = h.engine.getRule(ruleId)!;
    expect(rule.pausedAt).not.toBeNull();
    expect(hasEvent(h, "maintenance.paused")).toBe(1);
    expect(h.events("maintenance.paused")[0]!.payload).toMatchObject({ ruleId, rejections: 3 });

    h.complete(1);
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(3); // paused: no 4th run
    expect(h.engine.status().rules[0]!.blocked).toBe("paused");

    h.engine.resume(ruleId);
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(4);
  });

  it("an accepted card (draft -> todo) resets the streak; deleting after archiving counts once", async () => {
    const h = setup({ yml });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    const ruleId = `${h.project.id}:git-health`;
    const counter = () => h.engine.status().rules[0]!.counters.rejects ?? 0;

    h.complete(1);
    await h.engine.tick();
    const first = h.maintenanceCards()[0]!;
    h.store.cards.archive(first.id);
    await h.engine.tick();
    h.store.cards.delete(first.id); // archived draft deleted afterwards: still one rejection
    await h.engine.tick();
    expect(counter()).toBe(1);

    h.clock.advance(DAY);
    h.complete(1);
    await h.engine.tick();
    const second = h.maintenanceCards().find((c) => !c.archivedAt && c.id !== first.id)!;
    h.store.cards.move(second.id, { to: "todo", actor: "user" });
    await h.engine.tick();
    expect(counter()).toBe(0);
    expect(h.engine.getRule(ruleId)!.pausedAt).toBeNull();
  });

  it("a user deleting a never-archived draft is a rejection too", async () => {
    const h = setup({ yml });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    h.store.cards.delete(h.maintenanceCards()[0]!.id);
    await h.engine.tick();
    expect(h.engine.status().rules[0]!.counters.rejects).toBe(1);
  });
});

describe("time and event triggers", () => {
  it("fires a cron rule once per scheduled time, surviving restarts via the run log", async () => {
    const start = new Date(2026, 9, 19, 0, 30).getTime();
    const h = setup({
      start,
      yml: `rules:
  - name: nightly
    trigger: { kind: time, cron: "0 3 * * *" }
    check: { type: git, outdated: false }
    dedupe_key: nightly
    daily_cap: 5
`,
    });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    const ruleId = `${h.project.id}:nightly`;
    expect(h.engine.listRuns(ruleId)).toHaveLength(0);

    h.clock.advance(2 * 3_600_000); // 02:30
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(0);

    h.clock.advance(45 * 60_000); // 03:15
    await h.engine.tick();
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(1);

    h.clock.advance(DAY); // next night
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(2);
  });

  it("fires an event rule only for newly appended matching lines", async () => {
    const h = setup({
      yml: `rules:
  - name: crash-watch
    trigger: { kind: event, path: crash.log, pattern: "Exception" }
    check: { type: git, outdated: false }
    dedupe_key: crash-watch
    daily_cap: 5
`,
    });
    const log = join(h.repo, "crash.log");
    writeFileSync(log, "old Exception from before\n");
    await h.engine.tick(); // baseline
    const ruleId = `${h.project.id}:crash-watch`;
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(0);

    appendFileSync(log, "all fine\n");
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(0);

    appendFileSync(log, "java.lang.Exception: boom\n");
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(1);
    await h.engine.tick();
    expect(h.engine.listRuns(ruleId)).toHaveLength(1);
  });
});

describe("rules from maintenance.yml", () => {
  it("keeps the built-in rule, lets the file override it, and reports invalid entries", async () => {
    const h = setup({
      yml: `rules:
  - name: git-health
    enabled: false
    trigger: { kind: workload, cards_done: 10 }
    check: { type: git }
  - name: broken
    trigger: { kind: workload }
    check: { type: git }
`,
    });
    await h.engine.tick();
    const rules = h.engine.listRules(h.project.id);
    expect(rules.map((r) => r.name)).toEqual(["git-health"]);
    expect(rules[0]!.enabled).toBe(false);
    const errors = Object.values(h.engine.status().configErrors).flat();
    expect(errors.join()).toContain("broken");
  });

  it("defaults: built-in git-health is low priority, capped at 1 a day, suggest-only", async () => {
    const h = setup();
    await h.engine.tick();
    expect(h.engine.listRules(h.project.id)[0]).toMatchObject({
      name: "git-health",
      outputMode: "suggest",
      priority: "low",
      dailyCap: 1,
      triggerKind: "workload",
    });
  });

  it("survives a malformed file and picks the rules up once it is fixed", async () => {
    const h = setup({ yml: "rules: [oops" });
    await h.engine.tick();
    expect(h.engine.listRules(h.project.id).map((r) => r.name)).toEqual(["git-health"]);
    writeFileSync(
      join(h.repo, ".vibe", "maintenance.yml"),
      "rules:\n  - name: extra\n    trigger: { kind: time, cron: '0 4 * * *' }\n    check: { type: git }\n",
    );
    await h.engine.tick();
    expect(h.engine.listRules(h.project.id).map((r) => r.name)).toEqual(["extra", "git-health"]);
  });
});

describe("sub agent and fix output", () => {
  const rule = (extra: string) => `rules:
  - name: tidy
    trigger: { kind: workload, cards_done: 1 }
    check: { type: git, outdated: false }
    dedupe_key: tidy
${extra}`;

  it("passes the deterministic findings to the sub agent and stores its reply on the draft", async () => {
    const prompts: string[] = [];
    const subAgent: SubAgentRunner = {
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return "Delete the merged branches first.";
      },
    };
    const h = setup({ yml: rule("    agent: claude/sonnet\n"), engine: { subAgent } });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    const card = h.maintenanceCards()[0]!;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("dirty.txt");
    const note = h.store.events.list(card.id).find((e) => e.type === "note")!;
    expect((note.body as { text: string }).text).toContain("merged branches");
    expect((note.body as { warning?: string }).warning).toBeUndefined();
  });

  it("flags a sub agent that touched the repository", async () => {
    const subAgent: SubAgentRunner = {
      run: async ({ project }) => {
        writeFileSync(join(project.repoPath, "sneaky.txt"), "oops\n");
        return "done";
      },
    };
    const h = setup({ yml: rule("    agent: claude/sonnet\n"), engine: { subAgent } });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    const note = h.store.events.list(h.maintenanceCards()[0]!.id).find((e) => e.type === "note")!;
    expect((note.body as { warning?: string }).warning).toMatch(/changed the repository/);
  });

  it("keeps the draft when the sub agent fails", async () => {
    const subAgent: SubAgentRunner = {
      run: async () => {
        throw new Error("quota");
      },
    };
    const h = setup({ yml: rule("    agent: claude/sonnet\n"), engine: { subAgent } });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    expect(h.maintenanceCards()).toHaveLength(1);
    const kinds = h.store.events.list(h.maintenanceCards()[0]!.id).map((e) => (e.body as { kind?: string })?.kind);
    expect(kinds).toContain("sub_agent_failed");
  });

  it("fix mode creates the card directly in in_progress with a worker session", async () => {
    const launches: string[] = [];
    const fixLauncher: FixLauncher = {
      provider: () => "claude",
      launch: async ({ cardKey, agentId }) => {
        launches.push(`${cardKey}:${agentId}`);
        return { workspaceId: "ws-1", worktree: "/tmp/wt" };
      },
    };
    const h = setup({ yml: rule("    output: fix\n"), engine: { fixLauncher, newId: () => "agent-fix-1" } });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    const card = h.maintenanceCards()[0]!;
    expect(card).toMatchObject({ column: "in_progress", origin: "maintenance", priority: "low", worktree: "/tmp/wt" });
    expect(launches).toEqual([`${card.key}:agent-fix-1`]);
    expect(h.store.sessions.list({ cardId: card.id })[0]).toMatchObject({ agentId: "agent-fix-1", role: "worker" });
    // a verified fix is rejected by the user -> counts toward the auto pause
    h.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    h.store.cards.move(card.id, { to: "in_progress", actor: "user", reason: "not good" });
    await h.engine.tick();
    const view = h.engine.status().rules.find((r) => (r.rule as { name: string }).name === "tidy");
    expect(view!.counters.rejects).toBe(1);
  });

  it("archives the card and fails the run when the worker cannot be launched", async () => {
    const fixLauncher: FixLauncher = {
      provider: () => "claude",
      launch: async () => {
        throw new Error("no daemon");
      },
    };
    const h = setup({ yml: rule("    output: fix\n"), engine: { fixLauncher } });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    const [card] = h.maintenanceCards();
    expect(card!.archivedAt).not.toBeNull();
    const run = h.engine.listRuns(`${h.project.id}:tidy`)[0]!;
    expect(run.status).toBe("failed");
    expect(JSON.stringify(run.findings)).toContain("no daemon");
  });

  it("records the actual maintenance fallback session and model index for later runtime failures", async () => {
    let presetId = "";
    const fixLauncher: FixLauncher = {
      provider: () => "codex",
      launch: async () => ({ workspaceId: "ws", worktree: null, agentId: "fallback-worker", provider: "claude", presetId, model: "second", modelIndex: 1 }),
    };
    const h = setup({ yml: rule("    output: fix\n"), engine: { fixLauncher, newId: () => "initial-worker" } });
    presetId = h.store.presets.create({ name: "维护", provider: "codex", model: "first", models: [
      { provider: "codex", model: "first", thinking: "", permissionMode: "auto" },
      { provider: "claude", model: "second", thinking: "", permissionMode: "auto" },
      { provider: "opencode", model: "third", thinking: "", permissionMode: "auto" },
    ] }).id;
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    h.complete(1);
    await h.engine.tick();
    const card = h.maintenanceCards()[0]!;
    const active = h.store.sessions.getByAgent("fallback-worker")!;
    expect(active).toMatchObject({ currentProvider: "claude", role: "worker", workspaceId: "ws" });
    expect(h.store.cards.get(card.id)?.presetId).toBe(presetId);
    expect(h.store.sessions.getByAgent("initial-worker")?.state).toBe("ended");
    expect(h.store.events.list(card.id).map((e) => e.body)).toContainEqual({ kind: "model_selected", sessionId: active.id, presetId, modelIndex: 1, provider: "claude", model: "second" });
  });

  it("runNow ignores thresholds, the cap and a pause", async () => {
    const h = setup({ yml: rule("") });
    writeFileSync(join(h.repo, "dirty.txt"), "dirty\n");
    await h.engine.tick();
    const ruleId = `${h.project.id}:tidy`;
    const first = await h.engine.runNow(ruleId);
    const second = await h.engine.runNow(ruleId);
    expect(first.status).toBe("fired");
    expect(second.status).toBe("fired");
    expect(h.maintenanceCards()).toHaveLength(1); // deduped
  });
});
