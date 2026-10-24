// WP-93: kept history + hand-off, configurable triggers and prompts, project context, requirements
// maintenance (real temp git repo).

import { describe, expect, it } from "vitest";
import { masterPromptDefs } from "../server/prompts/defs";
import { composeRules } from "../server/prompts/port";
import { createMasterRuntime } from "../server/runtime";
import { renderPromptTemplate, unknownPromptPlaceholders } from "../server/vibe/contract";
import { REMOVED_SETTING_KEYS, masterSettings } from "../shared/rpc";
import {
  ManualClock,
  askMaster,
  choosePreset,
  defaultSettings,
  fakePaseo,
  setupBoard,
  tempDir,
} from "./helpers";

function runtimeFor(
  board: ReturnType<typeof setupBoard>,
  script: Parameters<typeof fakePaseo>[0],
  over: Parameters<typeof defaultSettings>[0] = {},
) {
  const clock = new ManualClock();
  const fake = fakePaseo(script);
  const settings = defaultSettings({ permissionMode: "auto", ...over });
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

describe("settings upgrade", () => {
  it("fills every new field with its default for values stored by an older version", () => {
    const old = masterSettings.schema.parse({
      enabled: true,
      provider: "codex",
      sweepOnStart: false,
    });
    expect(old).toMatchObject({
      provider: "codex",
      sweepOnStart: false,
      consolidateOnDone: true,
      maintainRequirements: true,
      rulesSupplement: "",
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
    expect(renderPromptTemplate("A {{x}} B {{ y.z }} C {{nope}}", { x: "1", "y.z": "2" })).toBe(
      "A 1 B 2 C ",
    );
    expect(renderPromptTemplate("{{x}}", { x: "$&$1" })).toBe("$&$1");
    const done = masterPromptDefs().find((d) => d.key === "master.wake.task_done")!;
    expect(
      unknownPromptPlaceholders("{{workspace}} {{typo}} {{typo}}", done.placeholders ?? []),
    ).toEqual(["typo"]);
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
    expect(composeRules("RULES", " be brief ")).toContain(
      "RULES\n\n## Owner supplement (from settings)\n\nbe brief",
    );
  });
});

describe("kept history and hand-off", () => {
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
    const { runtime, fake, settings } = runtimeFor(board, () => "ok");
    await askMaster(runtime);
    board.store.prompts.setOverride("master.rules_supplement", "Always answer in Chinese.");
    await askMaster(runtime);
    await askMaster(runtime);
    const prompts = fake.agents[0]!.prompts;
    expect(prompts[1]).toContain("Always answer in Chinese.");
    expect(prompts[2]).not.toContain("Always answer in Chinese.");

    // and a newly started agent has it in the system prompt
    const sonnet = board.store.presets.create({
      name: "Claude Sonnet",
      provider: "claude",
      model: "sonnet-x",
    });
    await choosePreset({ settings, runtime }, sonnet.id);
    expect(String(fake.agents[1]!.options.config.systemPrompt)).toContain(
      "Always answer in Chinese.",
    );
    await runtime.dispose();
  });
});
