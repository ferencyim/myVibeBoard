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
  assessmentJson,
  defaultSettings,
  fakeMaster,
  fakePaseo,
  setupBoard,
  tempDir,
  type Board,
  type Script,
} from "./helpers";

function runtimeFor(board: Board, script: Script, over: Parameters<typeof defaultSettings>[0] = {}) {
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

const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("registration", () => {
  it("registers every master prompt with its metadata, and a restart keeps the owner's overrides", async () => {
    const board = setupBoard();
    const first = runtimeFor(board, () => assessmentJson());
    const keys = board.store.prompts.list().map((p) => p.key);
    expect(keys.sort()).toEqual(masterPromptDefs().map((d) => d.key).sort());
    const rules = board.store.prompts.list().find((p) => p.key === "master.rules")!;
    expect(rules).toMatchObject({ plugin: "vibe-master", role: "master", source: "default", defaultText: MASTER_RULES });
    for (const p of board.store.prompts.list()) {
      expect(p.title && p.description && p.whenSent && p.audience).toBeTruthy();
    }
    board.store.prompts.setOverride("master.rules", "My own rules");
    await first.runtime.dispose();

    const second = runtimeFor(board, () => assessmentJson());
    expect(board.store.prompts.list().find((p) => p.key === "master.rules")).toMatchObject({
      source: "global",
      globalOverride: "My own rules",
      defaultText: MASTER_RULES,
    });
    await second.runtime.dispose();
  });

  it("the card_done reply format follows the requirements switch", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => assessmentJson(), { maintainRequirements: false });
    const suffix = () => board.store.prompts.list().find((p) => p.key === "master.wake.card_done")!.fixedSuffix;
    expect(suffix()).not.toContain("requirementsUpdate");
    await runtime.dispose();
    const on = runtimeFor(board, () => assessmentJson(), { maintainRequirements: true });
    expect(suffix()).toContain("requirementsUpdate");
    await on.runtime.dispose();
  });

  it("default rendering without a database equals the registry without overrides", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => assessmentJson());
    const vars = { "card.key": "A-1", project: "P", pending: "hello" };
    for (const key of ["master.wake.assess_draft", "master.plan.turn", "master.repair_json"] as const) {
      expect(defaultPromptPort().resolve(key, { vars })).toBe(board.store.prompts.resolve(key, { vars }));
    }
    await runtime.dispose();
  });
});

describe("scopes", () => {
  it("a project override reaches that project's wake message only; other projects use the global text", async () => {
    const board = setupBoard();
    const other = board.store.projects.create({ name: "Other", prefix: "OTH", repoPath: tempDir("vibe-master-repo2-"), projectType: "web" });
    const { runtime, fake } = runtimeFor(board, () => assessmentJson());
    board.store.prompts.setOverride("master.wake.assess_draft", "GLOBAL {{card.key}}");
    board.store.prompts.setOverride("master.wake.assess_draft", "PROJECT {{card.key}}", { projectId: board.project.id });
    const mine = board.draft("Mine");
    const theirs = board.store.cards.create({ projectId: other.id, title: "Theirs", description: "d" });
    runtime.triggers.assessNow(mine.id);
    runtime.triggers.assessNow(theirs.id);
    await runtime.queue.idle();
    const sent = fake.agents[0]!.prompts;
    expect(sent.some((p) => p.startsWith(`PROJECT ${mine.key}`))).toBe(true);
    expect(sent.some((p) => p.startsWith(`GLOBAL ${theirs.key}`))).toBe(true);
    await runtime.dispose();
  });

  it("the JSON repair message is the registered one", async () => {
    const board = setupBoard();
    board.draft("Bad reply");
    let calls = 0;
    const { runtime, fake } = runtimeFor(board, () => (++calls === 1 ? "not json" : assessmentJson()));
    board.store.prompts.setOverride("master.repair_json", "FIX IT ({{kind}}): {{error}}");
    runtime.triggers.assessNow(board.store.cards.list({ column: "draft" })[0]!.id);
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts[1]).toMatch(/^FIX IT \(assess_draft\): /);
    await runtime.dispose();
  });
});

describe("rules reach running agents", () => {
  it("resends the full rules once when the rules body changes, and not when the text is unchanged", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => assessmentJson());
    const wake = async (title: string) => {
      runtime.triggers.assessNow(board.draft(title).id);
      await runtime.queue.idle();
    };
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
    const { runtime, fake } = runtimeFor(board, () => assessmentJson());
    runtime.triggers.assessNow(board.draft("A").id);
    await runtime.queue.idle();
    expect(String(fake.agents[0]!.options.config.systemPrompt)).toBe("SYSTEM OVERRIDE");
    await runtime.dispose();
  });

  it("planning sessions get the project's rules and a notice when they change", async () => {
    const board = setupBoard();
    const fake = fakePaseo(() => fence({ reply: "ok", research: [] }));
    const store = board.store;
    store.prompts.register(masterPromptDefs());
    const planning = createPlanning({
      db: board.db,
      store,
      getPaseo: () => fake.paseo,
      master: fakeMaster(fake),
      rules: (projectId) => rulesFor({ resolve: (k, o) => store.prompts.resolve(k, o) }, projectId),
      prompts: { resolve: (k, o) => store.prompts.resolve(k, o) },
      dataDir: tempDir("vibe-master-data-"),
      clock: new ManualClock(),
      memory: { snapshot: () => ({}), apply: () => ({ stateWritten: false, added: 0, superseded: 0, archived: 0, duplicates: 0 }) },
      enabled: () => true,
      log: () => undefined,
    });
    store.prompts.setOverride("master.rules", "PROJECT RULES", { projectId: board.project.id });
    const card = board.draft("Plan me");
    store.cards.addChat({ cardId: card.id, authorKind: "user", author: "user", text: "first" });
    await planning.trigger(card.id);
    expect(String(fake.agents[0]!.options.config.systemPrompt)).toBe("PROJECT RULES");
    store.prompts.setOverride("master.rules_supplement", "Be terse.", { projectId: board.project.id });
    store.cards.addChat({ cardId: card.id, authorKind: "user", author: "user", text: "second" });
    await planning.trigger(card.id);
    const turn = fake.agents[0]!.prompts.at(-1)!;
    expect(turn).toContain("[总 agent 规则已更新");
    expect(turn).toContain("Be terse.");
    expect(turn).toContain("[plan:turn]");
    store.cards.addChat({ cardId: card.id, authorKind: "user", author: "user", text: "third" });
    await planning.trigger(card.id);
    expect(fake.agents[0]!.prompts.at(-1)).not.toContain("[总 agent 规则已更新");
    await planning.stop();
  });

  it("hashes the composed rules (body and supplement)", () => {
    const board = setupBoard();
    board.store.prompts.register(masterPromptDefs());
    const port = { resolve: (k: Parameters<typeof board.store.prompts.resolve>[0], o?: Parameters<typeof board.store.prompts.resolve>[1]) => board.store.prompts.resolve(k, o) };
    const before = hashText(rulesFor(port as never));
    board.store.prompts.setOverride("master.rules_supplement", "extra");
    expect(hashText(rulesFor(port as never))).not.toBe(before);
  });
});

describe("migration of the old settings", () => {
  const legacy = (over: Partial<Record<keyof typeof LEGACY_PROMPT_KEYS, string>> = {}) => ({
    rulesSupplement: "",
    templateAssessDraft: "",
    templateCardDone: "",
    templateSessionHelp: "",
    ...over,
  });

  it("copies the four legacy values to global overrides exactly once", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => assessmentJson());
    const done = migrateLegacyPromptSettings(
      board.db,
      board.store,
      legacy({ rulesSupplement: "Chinese please", templateAssessDraft: "A {{card.key}}", templateSessionHelp: "H {{plan}}" }),
    );
    expect(done.sort()).toEqual(["master.rules_supplement", "master.wake.assess_draft", "master.wake.session_help"]);
    const info = (key: string) => board.store.prompts.list().find((p) => p.key === key)!;
    expect(info("master.rules_supplement")).toMatchObject({ source: "global", globalOverride: "Chinese please" });
    expect(info("master.wake.card_done").source).toBe("default");

    // the owner resets one on the new page; a later start must not bring the old value back
    board.store.prompts.clearOverride("master.wake.assess_draft");
    expect(migrateLegacyPromptSettings(board.db, board.store, legacy({ templateAssessDraft: "A {{card.key}}" }))).toEqual([]);
    expect(info("master.wake.assess_draft").source).toBe("default");
    await runtime.dispose();
  });

  it("never replaces an override that already exists, and an all-blank settings page migrates nothing", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => assessmentJson());
    board.store.prompts.setOverride("master.wake.card_done", "already edited");
    expect(migrateLegacyPromptSettings(board.db, board.store, legacy({ templateCardDone: "old" }))).toEqual([]);
    expect(board.store.prompts.body("master.wake.card_done").text).toBe("already edited");
    await runtime.dispose();
  });

  it("runs from the runtime with the live settings", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => assessmentJson(), { rulesSupplement: "From settings" });
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
      proposalWindowMs: 15_000,
      projectBlockCardLimit: 40,
    });
  });

  it("the ask timeout, the repair retries and the project block size follow the settings", async () => {
    const board = setupBoard();
    for (let i = 0; i < 6; i++) board.draft(`Filler ${i}`);
    let calls = 0;
    const { runtime, fake } = runtimeFor(board, () => (++calls <= 3 ? "not json" : assessmentJson()), {
      askTimeoutMinutes: 7,
      jsonRepairRetries: 2,
      projectBlockCardLimit: 2,
    });
    const card = board.draft("Target");
    runtime.triggers.assessNow(card.id);
    await runtime.queue.idle();
    const agent = fake.agents[0]!;
    expect(agent.timeouts[0]).toBe(7 * 60_000);
    // first ask + two repair asks, then the reply is accepted
    expect(agent.prompts.length).toBeGreaterThanOrEqual(3);
    expect(agent.prompts[0]!.match(/^- DEMO-\d+ \[/gm)!.length).toBeLessThanOrEqual(2);
    await runtime.dispose();
  });

  it("no retries means the first bad reply fails the assessment", async () => {
    const board = setupBoard();
    const { runtime, fake } = runtimeFor(board, () => "still not json", { jsonRepairRetries: 0 });
    const card = board.draft("No retry");
    runtime.triggers.assessNow(card.id);
    await runtime.queue.idle();
    expect(fake.agents[0]!.prompts).toHaveLength(1);
    expect(board.store.events.list(card.id).some((e) => (e.body as { kind?: string }).kind === "assessment_failed")).toBe(true);
    await runtime.dispose();
  });
});
