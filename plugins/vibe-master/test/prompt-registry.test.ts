// WP-98: every master prompt comes from the shared registry (global / per-project overrides),
// the old settings are migrated once, changed rules reach running agents, and the automation
// parameters are settings.

import { describe, expect, it } from "vitest";
import { createPlanning } from "../server/planning/planner";
import { masterPromptDefs } from "../server/prompts/defs";
import { LEGACY_PROMPT_KEYS, migrateLegacyPromptSettings } from "../server/prompts/migrate";
import { defaultPromptPort, hashText } from "../server/prompts/port";
import { createMasterRuntime } from "../server/runtime";
import { MASTER_RULES } from "../server/master/rules.generated";
import { DEFAULT_TUNING, tuningOf } from "../server/tuning";
import { masterSettings } from "../shared/rpc";
import { rulesFor } from "../server/prompts/port";
import {
  ManualClock,
  askMaster,
  defaultSettings,
  fakePaseo,
  setupBoard,
  tempDir,
  type Board,
  type Script,
} from "./helpers";

function runtimeFor(
  board: Board,
  script: Script,
  over: Parameters<typeof defaultSettings>[0] = {},
) {
  const clock = new ManualClock();
  const fake = fakePaseo(script);
  const settings = defaultSettings(over);
  const runtime = createMasterRuntime({
    admitMaster: async () => async () => undefined,
    admitMemory: async () => async () => undefined,
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

function doneCard(board: Board, title: string) {
  const card = board.store.cards.create(
    { projectId: board.project.id, title, description: "d" },
    "user",
  );
  board.store.cards.move(card.id, { to: "todo", actor: "user" });
  board.store.cards.dispatch({
    cardId: card.id,
    agentId: `w-${title}`,
    provider: "claude",
    worktree: null,
  });
  board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
  board.store.cards.move(card.id, { to: "done", actor: "user" });
  return card;
}

const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("registration", () => {
  it("registers every master prompt with its metadata, and a restart keeps the owner's overrides", async () => {
    const board = setupBoard();
    const first = runtimeFor(board, () => "ok");
    const keys = board.store.prompts.list().map((p) => p.key);
    expect(keys.sort()).toEqual(
      masterPromptDefs()
        .map((d) => d.key)
        .sort(),
    );
    const rules = board.store.prompts.list().find((p) => p.key === "master.rules")!;
    expect(rules).toMatchObject({
      plugin: "vibe-master",
      role: "master",
      source: "default",
      defaultText: MASTER_RULES,
    });
    for (const p of board.store.prompts.list()) {
      expect(p.title && p.description && p.whenSent && p.audience).toBeTruthy();
    }
    board.store.prompts.setOverride("master.rules", "My own rules");
    await first.runtime.dispose();

    const second = runtimeFor(board, () => "ok");
    expect(board.store.prompts.list().find((p) => p.key === "master.rules")).toMatchObject({
      source: "global",
      globalOverride: "My own rules",
      defaultText: MASTER_RULES,
    });
    await second.runtime.dispose();
  });

  it("the card_done reply format follows the requirements switch", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok", { maintainRequirements: false });
    const suffix = () =>
      board.store.prompts.list().find((p) => p.key === "master.wake.card_done")!.fixedSuffix;
    expect(suffix()).not.toContain("requirementsUpdate");
    await runtime.dispose();
    const on = runtimeFor(board, () => "ok", { maintainRequirements: true });
    expect(suffix()).toContain("requirementsUpdate");
    await on.runtime.dispose();
  });

  it("default rendering without a database equals the registry without overrides", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok");
    const vars = { "card.key": "A-1", project: "P", pending: "hello" };
    for (const key of [
      "master.wake.card_done",
      "master.plan.turn",
      "master.repair_json",
    ] as const) {
      expect(defaultPromptPort().resolve(key, { vars })).toBe(
        board.store.prompts.resolve(key, { vars }),
      );
    }
    await runtime.dispose();
  });
});

describe("scopes", () => {
  it("a project override reaches that project's wake message only; other projects use the global text", async () => {
    const board = setupBoard();
    const other = board.store.projects.create({
      name: "Other",
      prefix: "OTH",
      repoPath: tempDir("vibe-master-repo2-"),
      projectType: "web",
    });
    const { runtime, fake } = runtimeFor(board, () => JSON.stringify({ summary: "m" }));
    board.store.prompts.setOverride("master.wake.card_done", "GLOBAL {{card.key}}");
    board.store.prompts.setOverride("master.wake.card_done", "PROJECT {{card.key}}", {
      projectId: board.project.id,
    });
    const finish = (projectId: string, title: string) => {
      const card = board.store.cards.create({ projectId, title, description: "d" }, "user");
      board.store.cards.move(card.id, { to: "todo", actor: "user" });
      board.store.cards.dispatch({
        cardId: card.id,
        agentId: `w-${title}`,
        provider: "claude",
        worktree: null,
      });
      board.store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
      board.store.cards.move(card.id, { to: "done", actor: "user" });
      return card;
    };
    const mine = finish(board.project.id, "Mine");
    const theirs = finish(other.id, "Theirs");
    runtime.queue.enqueue({ kind: "card_done", cardId: mine.id, force: true });
    runtime.queue.enqueue({ kind: "card_done", cardId: theirs.id, force: true });
    await runtime.queue.idle();
    const sent = fake.agents[0]!.prompts;
    expect(sent.some((p) => p.startsWith(`PROJECT ${mine.key}`))).toBe(true);
    expect(sent.some((p) => p.startsWith(`GLOBAL ${theirs.key}`))).toBe(true);
    await runtime.dispose();
  });

  it("the JSON repair message is the registered one", async () => {
    const board = setupBoard();
    const card = doneCard(board, "Bad reply");
    let calls = 0;
    const { runtime, fake } = runtimeFor(board, () =>
      ++calls === 1 ? "not json" : JSON.stringify({ summary: "m" }),
    );
    board.store.prompts.setOverride("master.repair_json", "FIX IT ({{kind}}): {{error}}");
    runtime.queue.enqueue({ kind: "card_done", cardId: card.id, force: true });
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts[1]).toMatch(/^FIX IT \(card_done\): /);
    await runtime.dispose();
  });
});

describe("rules reach running agents", () => {
  it("resends the full rules once when the rules body changes, and not when the text is unchanged", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "ok");
    const wake = async (_title: string) => void (await askMaster(runtime));
    await wake("A");
    board.store.prompts.setOverride("master.rules", "NEW RULES BODY");
    await wake("B");
    await wake("C");
    // setting the same text again changes nothing
    board.store.prompts.setOverride("master.rules", "NEW RULES BODY");
    await wake("D");
    const prompts = fake.agents[0]!.prompts;
    expect(prompts[1]).toContain("[总 agent 规则已更新");
    expect(prompts[1]).toContain("NEW RULES BODY");
    expect(prompts[2]).not.toContain("NEW RULES BODY");
    expect(prompts[3]).not.toContain("NEW RULES BODY");
    // restoring the default is a change again
    board.store.prompts.clearOverride("master.rules");
    await wake("E");
    expect(fake.agents[0]!.prompts[4]).toContain(MASTER_RULES.slice(0, 40));
    await runtime.dispose();
  });

  it("a new agent starts with the overridden rules as system prompt", async () => {
    const board = setupBoard();
    board.store.prompts.register(masterPromptDefs());
    board.store.prompts.setOverride("master.rules", "SYSTEM OVERRIDE");
    const { runtime, fake } = runtimeFor(board, () => "ok");
    await askMaster(runtime);
    expect(String(fake.agents[0]!.options.config.systemPrompt)).toBe("SYSTEM OVERRIDE");
    await runtime.dispose();
  });

  it("planning sessions get the project's planner prompt and a notice when it changes", async () => {
    const board = setupBoard();
    const fake = fakePaseo(() => fence({ reply: "ok" }));
    const store = board.store;
    store.prompts.register(masterPromptDefs());
    const planning = createPlanning({
      db: board.db,
      store,
      getPaseo: () => fake.paseo,
      prompts: { resolve: (k, o) => store.prompts.resolve(k, o) },
      dataDir: tempDir("vibe-master-data-"),
      clock: new ManualClock(),
      memory: {
        snapshot: () => ({
          "DECISIONS.md": [],
          "LESSONS.md": [],
          "INDEX.md": [],
          "PROJECT_STATE.md": [],
        }),
        apply: () => ({ stateWritten: false, added: 0, superseded: 0, archived: 0, duplicates: 0 }),
      },
      enabled: () => true,
      log: () => undefined,
    });
    store.prompts.setOverride("master.plan.system", "PROJECT RULES", {
      projectId: board.project.id,
    });
    const card = store.cards.update(board.draft("Plan me").id, {
      plannerPresetId: board.presets.claude.id,
    });
    const say = (text: string) =>
      store.cards.addChat({
        cardId: card.id,
        authorKind: "user",
        author: "user",
        text,
        thread: "plan",
      });
    say("first");
    await planning.trigger(card.id);
    expect(String(fake.agents[0]!.options.config.systemPrompt).startsWith("PROJECT RULES\n")).toBe(
      true,
    );
    store.prompts.setOverride("master.plan.system", "PROJECT RULES v2", {
      projectId: board.project.id,
    });
    say("second");
    await planning.trigger(card.id);
    const turn = fake.agents[0]!.prompts.at(-1)!;
    expect(turn).toContain("[总 agent 规则已更新");
    expect(turn).toContain("PROJECT RULES v2");
    say("third");
    await planning.trigger(card.id);
    expect(fake.agents[0]!.prompts.at(-1)).not.toContain("[总 agent 规则已更新");
    await planning.stop();
  });

  it("hashes the composed rules (body and supplement)", () => {
    const board = setupBoard();
    board.store.prompts.register(masterPromptDefs());
    const port = {
      resolve: (
        k: Parameters<typeof board.store.prompts.resolve>[0],
        o?: Parameters<typeof board.store.prompts.resolve>[1],
      ) => board.store.prompts.resolve(k, o),
    };
    const before = hashText(rulesFor(port as never));
    board.store.prompts.setOverride("master.rules_supplement", "extra");
    expect(hashText(rulesFor(port as never))).not.toBe(before);
  });
});

describe("migration of the old settings", () => {
  const legacy = (over: Partial<Record<keyof typeof LEGACY_PROMPT_KEYS, string>> = {}) => ({
    rulesSupplement: "",
    templateCardDone: "",
    ...over,
  });

  it("copies the legacy values to global overrides exactly once", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok");
    const done = migrateLegacyPromptSettings(
      board.db,
      board.store,
      legacy({ rulesSupplement: "Chinese please", templateCardDone: "D {{card.key}}" }),
    );
    expect(done.sort()).toEqual(["master.rules_supplement", "master.wake.card_done"]);
    expect(Object.keys(LEGACY_PROMPT_KEYS).sort()).toEqual(["rulesSupplement", "templateCardDone"]);
    const info = (key: string) => board.store.prompts.list().find((p) => p.key === key)!;
    expect(info("master.rules_supplement")).toMatchObject({
      source: "global",
      globalOverride: "Chinese please",
    });

    // the owner resets one on the new page; a later start must not bring the old value back
    board.store.prompts.clearOverride("master.wake.card_done");
    expect(
      migrateLegacyPromptSettings(
        board.db,
        board.store,
        legacy({ templateCardDone: "D {{card.key}}" }),
      ),
    ).toEqual([]);
    expect(info("master.wake.card_done").source).toBe("default");
    await runtime.dispose();
  });

  it("never replaces an override that already exists, and an all-blank settings page migrates nothing", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok");
    board.store.prompts.setOverride("master.wake.card_done", "already edited");
    expect(
      migrateLegacyPromptSettings(board.db, board.store, legacy({ templateCardDone: "old" })),
    ).toEqual([]);
    expect(board.store.prompts.body("master.wake.card_done").text).toBe("already edited");
    await runtime.dispose();
  });

  it("runs from the runtime with the live settings", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok", { rulesSupplement: "From settings" });
    expect(runtime.migrateLegacyPrompts()).toEqual(["master.rules_supplement"]);
    expect(runtime.migrateLegacyPrompts()).toEqual([]);
    await runtime.dispose();
  });
});

describe("automation parameters", () => {
  it("defaults of the settings equal the former hard-coded values", () => {
    expect(tuningOf(masterSettings.schema.parse({}))).toEqual(DEFAULT_TUNING);
    expect(DEFAULT_TUNING).toMatchObject({
      askTimeoutMs: 300_000,
      planTurnTimeoutMs: 600_000,
      scoutTimeoutMs: 300_000,
      maxResearchRounds: 2,
      maxPlanLoops: 10,
      jsonRepairRetries: 1,
      projectBlockCardLimit: 40,
    });
  });

  it("the ask timeout, the repair retries and the project block size follow the settings", async () => {
    const board = setupBoard();
    for (let i = 0; i < 6; i++) board.draft(`Filler ${i}`);
    let calls = 0;
    const { runtime, fake } = runtimeFor(
      board,
      () => (++calls <= 3 ? "not json" : JSON.stringify({ summary: "m" })),
      {
        askTimeoutMinutes: 7,
        jsonRepairRetries: 2,
        projectBlockCardLimit: 2,
      },
    );
    const card = doneCard(board, "Target");
    runtime.queue.enqueue({ kind: "card_done", cardId: card.id, force: true });
    await runtime.queue.idle();
    const agent = fake.agents[0]!;
    expect(agent.timeouts[0]).toBe(7 * 60_000);
    // first ask + two repair asks, then the reply is accepted
    expect(agent.prompts.length).toBeGreaterThanOrEqual(3);
    expect(agent.prompts[0]!.match(/^- DEMO-\d+ \[/gm)!.length).toBeLessThanOrEqual(2);
    await runtime.dispose();
  });

  it("no retries means the first bad reply fails the consolidation", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "still not json", { jsonRepairRetries: 0 });
    const card = doneCard(board, "No retry");
    runtime.queue.enqueue({ kind: "card_done", cardId: card.id, force: true });
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts).toHaveLength(1);
    expect(
      board.store.events
        .list(card.id)
        .some((e) => (e.body as { kind?: string }).kind === "memory_update_failed"),
    ).toBe(true);
    await runtime.dispose();
  });
});
