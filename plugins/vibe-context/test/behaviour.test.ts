// WP-99: the compaction / injection prompts come from the shared registry with defaults equal to the
// old hard-coded texts, and the former constants are settings with unchanged defaults.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARGIN_RULE,
  DEFAULT_TTL_SECONDS,
  FALLBACK_TTL_SECONDS,
  canCompact,
  coldStartPrompt,
  compactCommandFor,
  compactionSettings,
  marginFor,
  marginSeconds,
  notesPrompt,
  restorePrompt,
  ttlFor,
  type CompactionConfig,
} from "../server/compaction";
import { COMPACT_PROVIDERS } from "../server/compaction/policy";
import { complexitySettings } from "../server/complexity";
import { buildContextBlock, contextSettings, DEFAULT_MEMORY_TOKENS } from "../server/inject";
import { createMemoryStore } from "../server/memory";
import { CONTEXT_PROMPT_DEFS, createContextPrompts, defaultPrompts } from "../server/prompts";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";

const store = () => {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "core");
  return createVibeStore(db);
};

// The texts as they were hard-coded before the registry (compaction/scheduler.ts, inject/content.ts).
const ORIGINAL_NOTES = (mdPath: string, cardRef?: string) =>
  "Your context is about to be compacted. Before that, save your progress notes: the goal, " +
  "what is done, what is in progress, next steps, key files and decisions, open questions. " +
  "Use the `vibe_session_note` tool of the `vibe-board` MCP server" +
  (cardRef ? ` with key "${cardRef}"` : "") +
  " (it overwrites " +
  `\`${mdPath}\` and needs no approval); only if that tool does not exist, write that file ` +
  'yourself (create or overwrite it). Do nothing else. Reply "saved" when done.';
const ORIGINAL_RESTORE = (block: string | null) =>
  "Context was compacted. The project context below is authoritative; continue from your " +
  `session notes. Reply "ok" only.\n\n${block ?? "(no project context)"}`;
const ORIGINAL_COLD = (oldSessionId: string, mdPath: string, block: string | null) =>
  `You continue session ${oldSessionId}, handed over because its context grew long or its cache expires. ` +
  `Read \`${mdPath}\` for its progress and the files under \`.vibe/\` for project memory, ` +
  `then carry on with the task.${block ? `\n\n${block}` : ""}`;
const ORIGINAL_FRAME =
  "# Project context (myVibeBoard)\n\nGenerated from the files under `.vibe/` when this session started. It is authoritative and " +
  "read-only for you: never edit these files; report needed corrections to the master agent " +
  "(for a board task, in a card comment).";
const ORIGINAL_SCOUT =
  "## Scouting (if the `vibe_scout` tool is available)\n" +
  "Before editing in a large repo, call `vibe_scout` once with several independent questions " +
  "(`kind`: locate / inventory / research) so cheap read-only sub-agents search in parallel; you get back " +
  "short findings with path:line anchors instead of reading everything yourself. Good for: locating code " +
  "in an unfamiliar repo, counting/listing usages in bulk, gathering facts from several sources. " +
  "Skip it for a small change in one or two known files. Verify anchors you rely on before editing.";

describe("prompt registry", () => {
  it("registers every context prompt with its metadata", () => {
    const board = store();
    createContextPrompts(board).register();
    const listed = board.prompts.list();
    expect(listed.map((p) => p.key).sort()).toEqual(
      [
        "context.cold_start",
        "context.compact_notes",
        "context.compact_restore",
        "context.inject_frame",
        "context.scout_guidance",
      ].sort(),
    );
    for (const p of listed) {
      expect(p.plugin).toBe("vibe-context");
      expect(p.title && p.description && p.whenSent && p.audience).toBeTruthy();
    }
    expect(CONTEXT_PROMPT_DEFS).toHaveLength(5);
  });

  it("the defaults resolve to the old hard-coded texts, registry or not", () => {
    const board = store();
    const registry = createContextPrompts(board);
    registry.register();
    for (const prompts of [registry, defaultPrompts]) {
      expect(notesPrompt("/wt/.vibe/sessions/c1.md", "DEMO-3", prompts)).toBe(ORIGINAL_NOTES("/wt/.vibe/sessions/c1.md", "DEMO-3"));
      expect(notesPrompt("/wt/x.md", null, prompts)).toBe(ORIGINAL_NOTES("/wt/x.md"));
      expect(restorePrompt("BLOCK", prompts)).toBe(ORIGINAL_RESTORE("BLOCK"));
      expect(restorePrompt(null, prompts)).toBe(ORIGINAL_RESTORE(null));
      expect(coldStartPrompt("s1", "/wt/x.md", "BLOCK", prompts)).toBe(ORIGINAL_COLD("s1", "/wt/x.md", "BLOCK"));
      expect(coldStartPrompt("s1", "/wt/x.md", null, prompts)).toBe(ORIGINAL_COLD("s1", "/wt/x.md", null));
      expect(prompts.resolve("context.inject_frame")).toBe(ORIGINAL_FRAME);
      expect(prompts.resolve("context.scout_guidance")).toBe(ORIGINAL_SCOUT);
    }
  });

  it("an override reaches the injected block and the compaction prompts", () => {
    const board = store();
    const prompts = createContextPrompts(board);
    prompts.register();
    board.prompts.setOverride("context.inject_frame", "# My frame");
    board.prompts.setOverride("context.scout_guidance", "## My scouting");
    board.prompts.setOverride("context.compact_notes", "Save notes to {{mdPath}}{{keyClause}}.");

    const root = mkdtempSync(join(tmpdir(), "vibe-ctx-"));
    mkdirSync(join(root, ".vibe"));
    const block = buildContextBlock(createMemoryStore({ projectRoot: root, userHome: root, contextWindowTokens: 100_000 }), { prompts })!;
    expect(block).toContain("# My frame");
    expect(block).toContain("## My scouting");
    expect(block).not.toContain("Generated from the files");
    expect(block.startsWith("<!-- vibe:context:start -->")).toBe(true); // the markers stay code
    expect(block.endsWith("<!-- vibe:context:end -->")).toBe(true);
    expect(notesPrompt("/m.md", "DEMO-1", prompts)).toBe('Save notes to /m.md with key "DEMO-1".');
    // the default block is unchanged without overrides
    const plain = buildContextBlock(createMemoryStore({ projectRoot: root, userHome: root, contextWindowTokens: 100_000 }))!;
    expect(plain).toContain(ORIGINAL_FRAME);
    expect(plain).toContain(ORIGINAL_SCOUT);
  });

  it("the memory budget defaults to the setting's default", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-ctx-"));
    mkdirSync(join(root, ".vibe"));
    writeFileSync(join(root, ".vibe", "PROJECT_STATE.md"), "");
    expect(DEFAULT_MEMORY_TOKENS).toBe(6000);
    expect(contextSettings.schema.parse({}).defaultMemoryTokens).toBe(6000);
  });
});

describe("settings", () => {
  it("compaction defaults equal the old constants", () => {
    const s = compactionSettings.schema.parse({});
    expect(s).toMatchObject({
      enabled: true,
      ttlSeconds: {},
      checkIntervalSeconds: 20,
      fallbackTtlSeconds: 300,
      marginLongFromSeconds: 3600,
      marginLongSeconds: 180,
      marginShortSeconds: 60,
      compactProviders: ["claude", "codex"],
      compactCommands: {},
      approvalWaitMinutes: 10,
    });
    expect(s.marginSeconds).toBeUndefined();
    expect(DEFAULT_TTL_SECONDS).toEqual({ claude: 3600, codex: 300 });
    expect(FALLBACK_TTL_SECONDS).toBe(300);
    expect(DEFAULT_MARGIN_RULE).toEqual({ longFrom: 3600, long: 180, short: 60 });
    expect([...COMPACT_PROVIDERS]).toEqual(["claude", "codex"]);
    expect(complexitySettings.schema.parse({}).tightMemoryTokens).toBe(1000);
  });

  it("the helpers use the defaults for a bare config and the settings otherwise", () => {
    const bare: CompactionConfig = { enabled: true, ttlSeconds: {} };
    expect(ttlFor(bare, "claude")).toBe(3600);
    expect(ttlFor(bare, "codex/gpt-5")).toBe(300);
    expect(ttlFor(bare, "kimi")).toBe(300);
    expect(marginFor(bare, 3600)).toBe(marginSeconds(3600));
    expect(marginFor(bare, 3600)).toBe(180);
    expect(marginFor(bare, 300)).toBe(60);
    expect(canCompact(bare, "claude")).toBe(true);
    expect(canCompact(bare, "kimi")).toBe(false);
    expect(compactCommandFor(bare, "claude/sonnet")).toBe("/compact");

    const custom: CompactionConfig = {
      enabled: true,
      ttlSeconds: { kimi: 900 },
      fallbackTtlSeconds: 120,
      marginLongFromSeconds: 600,
      marginLongSeconds: 100,
      marginShortSeconds: 20,
      compactProviders: ["kimi"],
      compactCommands: { kimi: "/summarize" },
    };
    expect(ttlFor(custom, "kimi")).toBe(900);
    expect(ttlFor(custom, "opencode")).toBe(120);
    expect(marginFor(custom, 900)).toBe(100);
    expect(marginFor(custom, 300)).toBe(20);
    expect(marginFor({ ...custom, marginSeconds: 7 }, 900)).toBe(7);
    expect(canCompact(custom, "kimi")).toBe(true);
    expect(canCompact(custom, "claude")).toBe(false);
    expect(compactCommandFor(custom, "kimi")).toBe("/summarize");
  });
});
