// WP-98: every master prompt comes from the shared registry (global / per-project overrides),
// the old settings are migrated once, changed rules reach running agents, and the automation
// parameters are settings.

import { describe, expect, it } from "vitest";
import { MASTER_RULES } from "../server/master/rules.generated";
import { masterPromptDefs } from "../server/prompts/defs";
import { LEGACY_PROMPT_KEYS, migrateLegacyPromptSettings } from "../server/prompts/migrate";
import { defaultPromptPort, hashText, rulesFor } from "../server/prompts/port";
import { createMasterRuntime } from "../server/runtime";
import { DEFAULT_TUNING, tuningOf } from "../server/tuning";
import { masterSettings } from "../shared/rpc";
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

describe("registration", () => {
  it("registers every master prompt with its metadata, and a restart keeps the owner's overrides", async () => {
    const board = setupBoard();
    const first = runtimeFor(board, () => "ok");
    const keys = board.store.prompts.list().map((p) => p.key);
    expect(
      keys.some(
        (key) =>
          key.startsWith("master.plan.") ||
          key === "master.dispatch" ||
          key === "master.wake.card_done",
      ),
    ).toBe(false);
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

  it("does not register the retired completion prompt", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok");
    expect(board.store.prompts.list().some((p) => p.key === "master.wake.task_done")).toBe(false);
    await runtime.dispose();
  });

  it("default rendering without a database equals the registry without overrides", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok");
    const vars = { "card.key": "A-1", project: "P", pending: "hello" };
    for (const key of ["master.rules_updated", "master.repair_json"] as const) {
      expect(defaultPromptPort().resolve(key, { vars })).toBe(
        board.store.prompts.resolve(key, { vars }),
      );
    }
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
  const legacy = (
    over: Partial<Record<keyof typeof LEGACY_PROMPT_KEYS | "templateCardDone", string>> = {},
  ) => ({
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
    expect(done.sort()).toEqual(["master.rules_supplement"]);
    expect(Object.keys(LEGACY_PROMPT_KEYS).sort()).toEqual(["rulesSupplement"]);
    const info = (key: string) => board.store.prompts.list().find((p) => p.key === key)!;
    expect(info("master.rules_supplement")).toMatchObject({
      source: "global",
      globalOverride: "Chinese please",
    });

    // the owner resets one on the new page; a later start must not bring the old value back
    board.store.prompts.clearOverride("master.rules_supplement");
    expect(
      migrateLegacyPromptSettings(
        board.db,
        board.store,
        legacy({ templateCardDone: "D {{card.key}}" }),
      ),
    ).toEqual([]);
    expect(info("master.rules_supplement").source).toBe("default");
    await runtime.dispose();
  });

  it("never replaces an override that already exists, and an all-blank settings page migrates nothing", async () => {
    const board = setupBoard();
    const { runtime } = runtimeFor(board, () => "ok");
    board.store.prompts.setOverride("master.rules_supplement", "already edited");
    expect(
      migrateLegacyPromptSettings(board.db, board.store, legacy({ templateCardDone: "old" })),
    ).toEqual([]);
    expect(board.store.prompts.body("master.rules_supplement").text).toBe("already edited");
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
      jsonRepairRetries: 1,
    });
  });
});
