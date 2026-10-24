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

// The default (Chinese) texts.
const ORIGINAL_NOTES = (mdPath: string) =>
  "你的上下文即将被压缩。压缩之前，请先保存进度笔记：目标、已完成的、进行中的、下一步、关键文件与决策、未解决的问题。请将笔记写到 `{{mdPath}}`（创建或覆盖）；若当前原生任务提供支持该路径的会话笔记工具，可使用它。除此之外什么都不要做。完成后回复“saved”。"
    .replace("{{mdPath}}", mdPath)
    .replace("{{keyClause}}", "");
const ORIGINAL_RESTORE = (block: string | null) =>
  "上下文已压缩。下面的项目上下文是权威依据；请根据你的会话笔记继续。" +
  `只回复“ok”。\n\n${block ?? "（无项目上下文）"}`;
const ORIGINAL_COLD = (oldSessionId: string, mdPath: string, block: string | null) =>
  `你接续会话 ${oldSessionId}：它因为上下文变长或缓存即将过期而被交接。` +
  `先读 \`${mdPath}\` 了解它的进度，再读 \`.vibe/\` 下的文件了解项目记忆，` +
  `然后继续完成任务。${block ? `\n\n${block}` : ""}`;
const ORIGINAL_FRAME =
  "# 项目上下文（myVibeBoard）\n\n" +
  "以下内容在本会话启动时由 `.vibe/` 下的文件生成，是权威依据，对你只读：" +
  "不要编辑这些文件；需要更正时在任务的原生会话里告知总 agent。";

describe("prompt registry", () => {
  it("registers every context prompt with its metadata", () => {
    const board = store();
    createContextPrompts(board).register();
    const listed = board.prompts.list();
    expect(listed.map((p) => p.key).sort()).toEqual(
      [
        "context.cold_start",
        "context.failure_handoff",
        "context.compact_notes",
        "context.compact_restore",
        "context.inject_frame",
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
      expect(notesPrompt("/wt/.vibe/sessions/c1.md", prompts)).toBe(
        ORIGINAL_NOTES("/wt/.vibe/sessions/c1.md"),
      );
      expect(notesPrompt("/wt/x.md", prompts)).toBe(ORIGINAL_NOTES("/wt/x.md"));
      expect(restorePrompt("BLOCK", prompts)).toBe(ORIGINAL_RESTORE("BLOCK"));
      expect(restorePrompt(null, prompts)).toBe(ORIGINAL_RESTORE(null));
      expect(coldStartPrompt("s1", "/wt/x.md", "BLOCK", prompts)).toBe(
        ORIGINAL_COLD("s1", "/wt/x.md", "BLOCK"),
      );
      expect(coldStartPrompt("s1", "/wt/x.md", null, prompts)).toBe(
        ORIGINAL_COLD("s1", "/wt/x.md", null),
      );
      expect(prompts.resolve("context.inject_frame")).toBe(ORIGINAL_FRAME);
    }
  });

  it("an override reaches the injected block and the compaction prompts", () => {
    const board = store();
    const prompts = createContextPrompts(board);
    prompts.register();
    board.prompts.setOverride("context.inject_frame", "# My frame");
    board.prompts.setOverride("context.compact_notes", "Save notes to {{mdPath}}{{keyClause}}.");

    const root = mkdtempSync(join(tmpdir(), "vibe-ctx-"));
    mkdirSync(join(root, ".vibe"));
    const block = buildContextBlock(
      createMemoryStore({ projectRoot: root, userHome: root, contextWindowTokens: 100_000 }),
      { prompts },
    )!;
    expect(block).toContain("# My frame");
    expect(block).not.toContain("由 `.vibe/` 下的文件生成");
    expect(block.startsWith("<!-- vibe:context:start -->")).toBe(true); // the markers stay code
    expect(block.endsWith("<!-- vibe:context:end -->")).toBe(true);
    expect(notesPrompt("/m.md", prompts)).toBe(`Save notes to /m.md.`);
    // the default block is unchanged without overrides
    const plain = buildContextBlock(
      createMemoryStore({ projectRoot: root, userHome: root, contextWindowTokens: 100_000 }),
    )!;
    expect(plain).toContain(ORIGINAL_FRAME);
    expect(plain).not.toContain("vibe_scout");
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
