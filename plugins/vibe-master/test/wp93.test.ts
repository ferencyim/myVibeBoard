// WP-93: kept history + hand-off, configurable triggers and prompts, project context, requirements
// maintenance (real temp git repo).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REMOVED_SETTING_KEYS, masterSettings } from "../shared/rpc";
import { MemoryUpdateSchema } from "../server/assess/schema";
import { buildHandoff, HANDOFF_MAX_CHARS } from "../server/master/handoff";
import { buildDoneMessage, buildProjectBlock } from "../server/master/prompts";
import { masterPromptDefs } from "../server/prompts/defs";
import { composeRules, defaultPromptPort } from "../server/prompts/port";
import { renderPromptTemplate, unknownPromptPlaceholders } from "../server/vibe/contract";
import { createConsolidator } from "../server/memory/consolidate";
import { createFileMemoryPort } from "../server/memory/files";
import { createMasterRuntime } from "../server/runtime";
import {
  ManualClock,
  askMaster,
  defaultSettings,
  fakePaseo,
  setupBoard,
  tempDir,
} from "./helpers";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(repo: string) {
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
}

function runtimeFor(
  board: ReturnType<typeof setupBoard>,
  script: Parameters<typeof fakePaseo>[0],
  over: Parameters<typeof defaultSettings>[0] = {},
) {
  const clock = new ManualClock();
  const fake = fakePaseo(script);
  const settings = defaultSettings(over);
  const runtime = createMasterRuntime({
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    settings: () => settings,
    dataDir: tempDir(),
    clock,
    pollIntervalMs: 3_600_000,
    log: () => undefined,
  });
  return { runtime, clock, fake, settings };
}

describe("settings upgrade", () => {
  it("fills every new field with its default for values stored by an older version", () => {
    const old = masterSettings.schema.parse({ enabled: true, provider: "codex", sweepOnStart: false });
    expect(old).toMatchObject({
      provider: "codex",
      sweepOnStart: false,
      consolidateOnDone: true,
      maintainRequirements: true,
      rulesSupplement: "",
      templateCardDone: "",
      requirementsExcerptChars: 6000,
    });
  });

  it("migrate drops the settings of the removed card-flow triggers and keeps the rest", () => {
    const stored = {
      enabled: false,
      provider: "codex",
      consolidateOnDone: false,
      ...Object.fromEntries(REMOVED_SETTING_KEYS.map((key) => [key, "old"])),
    };
    expect(REMOVED_SETTING_KEYS).toContain("debounceSeconds");
    expect(REMOVED_SETTING_KEYS).toContain("templateSessionHelp");
    const migrated = masterSettings.migrate!(stored, 1) as Record<string, unknown>;
    expect(migrated).toEqual({ enabled: false, provider: "codex", consolidateOnDone: false });
    // a non-object value passes through untouched
    expect(masterSettings.migrate!(null, 1)).toBeNull();
  });
});

describe("templates", () => {
  it("renders {{placeholders}} once, blanks unknown ones and reports them", () => {
    expect(renderPromptTemplate("A {{x}} B {{ y.z }} C {{nope}}", { x: "1", "y.z": "2" })).toBe("A 1 B 2 C ");
    expect(renderPromptTemplate("{{x}}", { x: "$&$1" })).toBe("$&$1");
    const done = masterPromptDefs().find((d) => d.key === "master.wake.card_done")!;
    expect(unknownPromptPlaceholders("{{card.key}} {{typo}} {{typo}}", done.placeholders ?? [])).toEqual(["typo"]);
  });

  it("keeps the reply-format section whatever the owner wrote", () => {
    const board = setupBoard();
    const card = board.draft("Templated");
    const input = { projectBlock: "PROJ", card, events: [], verification: "", memory: "" };
    board.store.prompts.register(masterPromptDefs());
    board.store.prompts.setOverride("master.wake.card_done", "Look at {{card.key}} only");
    const custom = buildDoneMessage({ ...input, prompts: { resolve: board.store.prompts.resolve } });
    expect(custom.startsWith(`Look at ${card.key} only\n\n`)).toBe(true);
    expect(custom.endsWith("只回复 card_done JSON 对象。")).toBe(true);
  });

  it("only mentions requirementsUpdate when requirements maintenance is on", () => {
    const board = setupBoard();
    const card = board.draft("Done soon");
    const input = { projectBlock: "P", card, events: [], verification: "", memory: "" };
    const off = buildDoneMessage({ ...input, prompts: defaultPromptPort({ maintainRequirements: false }) });
    expect(off).not.toContain("requirementsUpdate");
    const on = buildDoneMessage({ ...input, prompts: defaultPromptPort({ maintainRequirements: true }) });
    expect(on).toContain("requirementsUpdate");
    expect(on.endsWith("只回复 card_done JSON 对象。")).toBe(true);
  });

  it("documents every placeholder its default template uses", () => {
    for (const def of masterPromptDefs().filter((d) => d.placeholders?.length)) {
      expect(unknownPromptPlaceholders(def.defaultText, def.placeholders ?? [])).toEqual([]);
    }
    for (const def of masterPromptDefs().filter((d) => d.key.startsWith("master.wake."))) {
      expect(def.fixedSuffix).toContain("JSON 对象");
    }
  });

  it("appends the owner's rule supplement after the static rules", () => {
    expect(composeRules("RULES", "  ")).toBe("RULES");
    expect(composeRules("RULES", " be brief ")).toContain("RULES\n\n## Owner supplement (from settings)\n\nbe brief");
  });
});

describe("project context", () => {
  it("adds the description, every project type and the requirements excerpt (truncated with a note)", () => {
    const board = setupBoard();
    board.store.projects.update(board.project.id, { description: "A todo app for cats.", projectTypes: ["web", "android"] });
    writeFileSync(join(board.repoPath, "PRODUCT-REQUIREMENTS.md"), `# Needs\n${"line\n".repeat(2000)}`);
    const project = board.store.projects.get(board.project.id)!;
    const block = (chars?: number) =>
      buildProjectBlock({ project, tags: [], presets: [], openCards: [], requirementsChars: chars });

    const full = block(100_000);
    expect(full).toContain("类型 web+android");
    expect(full).toContain("简介：A todo app for cats.");
    expect(full).toContain("需求文档（PRODUCT-REQUIREMENTS.md，完整）");

    const cut = block(50);
    expect(cut).toContain("TRUNCATED");
    expect(cut).toContain("已截断：");
    expect(cut).not.toContain("line\nline\nline\nline\nline\nline\nline\nline\nline\nline");

    expect(block(0)).not.toContain("需求文档");
    // default limit applies when the caller passes nothing
    expect(block()).toContain("TRUNCATED");
  });

  it("omits the block when the document is missing or the path escapes the repository", () => {
    const board = setupBoard();
    const project = board.store.projects.get(board.project.id)!;
    expect(buildProjectBlock({ project, tags: [], presets: [], openCards: [] })).not.toContain("需求文档");
    expect(
      buildProjectBlock({ project: { ...project, requirementsPath: "../x.md" }, tags: [], presets: [], openCards: [] }),
    ).not.toContain("需求文档");
  });
});

describe("kept history and hand-off", () => {
  it("does not archive the replaced master, lists both sessions and hands the new one a board summary", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "ok");
    const done = board.store.cards.create({ projectId: board.project.id, title: "Shipped feature" }, "user");
    board.store.cards.move(done.id, { to: "todo", actor: "user" });
    board.store.cards.dispatch({ cardId: done.id, agentId: "w1", provider: "claude", worktree: null });
    board.store.cards.move(done.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(done.id, { to: "done", actor: "user" });
    const draft = board.draft("Untouched draft");
    await askMaster(runtime, "first");

    await runtime.switchTo({ provider: "codex", thinking: "max" }, "owner picked Codex");
    expect(fake.agents).toHaveLength(2);
    expect(fake.agents[0]!.archived).toBe(false);

    await askMaster(runtime, "after the switch");
    const first = fake.agents[1]!.prompts[0]!;
    expect(first).toContain("[handoff]");
    expect(first.indexOf("[handoff]")).toBeLessThan(first.indexOf("after the switch"));
    expect(first).toContain(draft.key);
    expect(first).toContain("Shipped feature");
    expect(first).toContain("尚未审查");
    expect(first).toContain("owner picked Codex");
    // delivered once only
    await askMaster(runtime, "another");
    expect(fake.agents[1]!.prompts[1]).not.toContain("[handoff]");

    const sessions = runtime.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ current: true, provider: "codex", model: "gpt-5-codex", thinking: "xhigh" });
    expect(sessions[1]).toMatchObject({
      current: false,
      provider: "claude",
      model: "opus-x",
      state: "ended",
      retiredReason: "switched",
      agentId: fake.agents[0]!.id,
    });
    expect(runtime.sessions(1)).toHaveLength(1);
    await runtime.dispose();
  });

  it("also keeps the old agent on a permission mode change", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "ok");
    await askMaster(runtime);
    await runtime.setPermission("acceptEdits");
    expect(fake.agents).toHaveLength(2);
    expect(fake.agents[0]!.archived).toBe(false);
    expect(runtime.sessions()[1]).toMatchObject({ retiredReason: "mode_changed" });
    await runtime.dispose();
  });

  it("the first master ever gets no hand-off", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "ok");
    await askMaster(runtime);
    expect(fake.agents[0]!.prompts[0]).not.toContain("[handoff]");
    await runtime.dispose();
  });

  it("sends a changed rule supplement to a running agent once", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "ok");
    await askMaster(runtime);
    board.store.prompts.setOverride("master.rules_supplement", "Always answer in Chinese.");
    await askMaster(runtime);
    await askMaster(runtime);
    const prompts = fake.agents[0]!.prompts;
    expect(prompts[1]).toContain("Always answer in Chinese.");
    expect(prompts[2]).not.toContain("Always answer in Chinese.");

    // and a newly started agent has it in the system prompt
    await runtime.switchTo({ provider: "claude", model: "sonnet-x" }, "again");
    expect(String(fake.agents[1]!.options.config.systemPrompt)).toContain("Always answer in Chinese.");
    await runtime.dispose();
  });

  it("builds a capped summary from the board alone", () => {
    const board = setupBoard();
    for (let i = 0; i < 40; i++) board.draft(`Draft number ${i} ${"x".repeat(80)}`);
    const text = buildHandoff({
      store: board.store,
      nowMs: Date.now(),
      switches: Array.from({ length: 30 }, (_, i) => ({ at: `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00Z`, text: "claude -> codex ".repeat(30) + i })),
    });
    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expect(text).toContain("## 草稿与审查状态");
    expect(text.match(/- DEMO-\d+/g)!.length).toBeLessThanOrEqual(8);
  });
});

describe("trigger switches", () => {
  it("skips memory consolidation when switched off", async () => {
    const board = setupBoard();
    const { runtime, fake, settings, clock } = runtimeFor(board, () => "ok");
    clock.advance(Date.now() - clock.now()); // the sweep window compares with real board timestamps
    settings.consolidateOnDone = false;
    const card = board.store.cards.create({ projectId: board.project.id, title: "Finished" }, "user");
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    board.store.cards.dispatch({ cardId: card.id, agentId: "w1", provider: "claude", worktree: null });
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    await runtime.triggers.consumer.poll();
    await runtime.queue.idle();
    expect(fake.agents).toHaveLength(0);
    expect(runtime.triggers.sweep()).toBe(0);

    settings.consolidateOnDone = true;
    expect(runtime.triggers.sweep()).toBe(1);
    await runtime.dispose();
  });

  it("applies a done template override from the registry to the next wake", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => JSON.stringify({ summary: "m" }));
    board.store.prompts.setOverride("master.wake.card_done", "CUSTOM {{card.key}}\n{{project}}");
    const card = board.store.cards.create({ projectId: board.project.id, title: "Done" }, "user");
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    board.store.cards.dispatch({ cardId: card.id, agentId: "w1", provider: "claude", worktree: null });
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    runtime.wake(card.key, "card_done", true);
    await runtime.queue.idle();
    const prompt = fake.agents[0]!.prompts[0]!;
    expect(prompt.startsWith(`CUSTOM ${card.key}\n## 项目 DEMO`)).toBe(true);
    expect(prompt.endsWith("只回复 card_done JSON 对象。")).toBe(true);
    await runtime.dispose();
  });
});

describe("requirements maintenance", () => {
  function setup(opts: { maintain?: boolean; chars?: number; doc?: string } = {}) {
    const board = setupBoard();
    initRepo(board.repoPath);
    writeFileSync(join(board.repoPath, "PRODUCT-REQUIREMENTS.md"), opts.doc ?? "# Requirements\n- old\n");
    git(board.repoPath, "add", ".");
    git(board.repoPath, "commit", "-q", "-m", "docs");
    const card = board.store.cards.create({ projectId: board.project.id, title: "Needs change" }, "user");
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    board.store.cards.dispatch({ cardId: card.id, agentId: "w1", provider: "claude", worktree: null });
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    const replies: string[] = [];
    const prompts: string[] = [];
    const master = {
      async ask(prompt: string) {
        prompts.push(prompt);
        return replies.shift() ?? "";
      },
    };
    const failures: string[] = [];
    const consolidator = createConsolidator({
      db: board.db,
      store: board.store,
      master,
      memory: createFileMemoryPort(),
      prompts: defaultPromptPort({ maintainRequirements: opts.maintain ?? true }),
      options: {
        maintainRequirements: () => opts.maintain ?? true,
        requirementsChars: () => opts.chars ?? 6000,
      },
      onRequirementsFailure: (key, message) => failures.push(`${key}: ${message}`),
    });
    const kinds = () =>
      board.store
        .events.list(card.id)
        .map((e) => (e.body as { kind?: string } | null)?.kind)
        .filter(Boolean);
    return { board, card, replies, prompts, consolidator, failures, kinds };
  }

  const reply = (requirementsUpdate: unknown) =>
    JSON.stringify({ summary: "memory", ...(requirementsUpdate ? { requirementsUpdate } : {}) });

  it("accepts the optional field in the schema", () => {
    expect(MemoryUpdateSchema.parse({ summary: "s" }).requirementsUpdate).toBeUndefined();
    expect(MemoryUpdateSchema.parse({ summary: "s", requirementsUpdate: { content: "c", summary: "d" } }).requirementsUpdate).toEqual({
      content: "c",
      summary: "d",
    });
    expect(() => MemoryUpdateSchema.parse({ summary: "s", requirementsUpdate: { content: "" , summary: "d" } })).toThrow();
  });

  it("writes the document and commits only that file with the agreed message", async () => {
    const t = setup();
    // an unrelated staged change must not be swept into the commit
    writeFileSync(join(t.board.repoPath, "other.txt"), "staged\n");
    git(t.board.repoPath, "add", "other.txt");
    t.replies.push(reply({ content: "# Requirements\n- new decision\n", summary: "Dark mode is required" }));

    const outcome = await t.consolidator.consolidate(t.card.key);
    expect(outcome.status).toBe("updated");
    expect(t.prompts[0]).toContain("requirementsUpdate");
    expect(t.prompts[0]).toContain("需求文档（PRODUCT-REQUIREMENTS.md，完整）");
    expect(readFileSync(join(t.board.repoPath, "PRODUCT-REQUIREMENTS.md"), "utf8")).toBe("# Requirements\n- new decision\n");
    expect(git(t.board.repoPath, "log", "-1", "--format=%s")).toBe(`docs(requirements): Dark mode is required [${t.card.key}]`);
    expect(git(t.board.repoPath, "show", "--name-only", "--format=", "HEAD")).toBe("PRODUCT-REQUIREMENTS.md");
    expect(git(t.board.repoPath, "diff", "--cached", "--name-only")).toBe("other.txt");
    expect(t.kinds()).toContain("requirements_update");
    expect(t.failures).toEqual([]);
  });

  it("is a no-op for unchanged content and ignores the field when the switch is off", async () => {
    const same = setup();
    same.replies.push(reply({ content: "# Requirements\n- old\n", summary: "nothing" }));
    await same.consolidator.consolidate(same.card.key);
    expect(git(same.board.repoPath, "log", "-1", "--format=%s")).toBe("docs");
    expect(same.kinds()).toContain("requirements_update");

    const off = setup({ maintain: false });
    off.replies.push(reply({ content: "# Requirements\n- sneaky\n", summary: "x" }));
    expect((await off.consolidator.consolidate(off.card.key)).status).toBe("updated");
    expect(readFileSync(join(off.board.repoPath, "PRODUCT-REQUIREMENTS.md"), "utf8")).toBe("# Requirements\n- old\n");
    expect(off.prompts[0]).not.toContain("requirementsUpdate");
    expect(off.kinds()).not.toContain("requirements_update");
  });

  it("records a note and a reminder when the repository is busy, and does not retry", async () => {
    const t = setup();
    writeFileSync(join(t.board.repoPath, ".git", "MERGE_HEAD"), "0".repeat(40) + "\n");
    t.replies.push(reply({ content: "# Requirements\n- new\n", summary: "Late change" }));
    expect((await t.consolidator.consolidate(t.card.key)).status).toBe("updated");
    expect(t.kinds()).toContain("requirements_update_failed");
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]).toContain("merge");
    expect(readFileSync(join(t.board.repoPath, "PRODUCT-REQUIREMENTS.md"), "utf8")).toBe("# Requirements\n- old\n");
    expect(t.replies).toEqual([]); // no extra master call
  });

  it("refuses to rewrite a document the master only saw in part", async () => {
    const t = setup({ doc: `# Big\n${"detail\n".repeat(200)}`, chars: 100 });
    t.replies.push(reply({ content: "# Big\n- replaced\n", summary: "Cut it" }));
    await t.consolidator.consolidate(t.card.key);
    expect(t.kinds()).toContain("requirements_update_failed");
    expect(t.failures[0]).toContain("摘录上限");
    expect(readFileSync(join(t.board.repoPath, "PRODUCT-REQUIREMENTS.md"), "utf8")).toContain("detail");
    mkdirSync(join(t.board.repoPath, "x"), { recursive: true });
  });

  it("reminds through the board alert when run inside the runtime", async () => {
    const board = setupBoard();
    initRepo(board.repoPath);
    writeFileSync(join(board.repoPath, ".gitignore"), "PRODUCT-REQUIREMENTS.md\n");
    git(board.repoPath, "add", ".");
    git(board.repoPath, "commit", "-q", "-m", "ignore");
    const { runtime } = runtimeFor(board, () =>
      JSON.stringify({ summary: "m", requirementsUpdate: { content: "# R\n", summary: "ignored file" } }),
    );
    const card = board.store.cards.create({ projectId: board.project.id, title: "Done" }, "user");
    board.store.cards.move(card.id, { to: "todo", actor: "user" });
    board.store.cards.dispatch({ cardId: card.id, agentId: "w1", provider: "claude", worktree: null });
    board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
    board.store.cards.move(card.id, { to: "done", actor: "user" });
    runtime.queue.enqueue({ kind: "card_done", cardId: card.id });
    await runtime.queue.idle();
    const alerts = board.db
      .prepare<{ payload_json: string }>("SELECT payload_json FROM vibe_event WHERE type = 'master.alert'")
      .all()
      .map((r) => JSON.parse(r.payload_json) as { kind: string });
    expect(alerts.map((a) => a.kind)).toContain("requirements_failed");
    await runtime.dispose();
  });
});
