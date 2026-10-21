import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePromptOverrideId, promptOverrideId } from "../server/vibe/contract";
import { ClientSync, MemoryChangeStore, type ExchangeResponse } from "../server/vibe/sync";
import { buildDispatchBrief } from "../server/dispatch/brief";
import { startAdmissionConsumer } from "../server/dispatch/admission";
import { createReassigner } from "../server/dispatch/reassign";
import { BOARD_INSTRUCTIONS_MARKER, buildBoardInstructions } from "../server/mcp/instructions";
import { injectBoard } from "../server/mcp/inject";
import { CONTINUE_PROMPT } from "../server/lifecycle/watchdog";
import { SCOUT_SYSTEM_PROMPT, createScoutService, trimSummary } from "../server/scout";
import { BOARD_PROMPT_DEFS, createBoardPrompts, defaultPrompts } from "../server/prompts";
import { registerBoardRpcs } from "../server/rpc";
import { createBoardService, openBoardRuntime } from "../server/service";
import { createSyncService } from "../server/sync";
import * as rpc from "../shared/rpc";
import { boardSettings } from "../shared/settings";
import { setupBoard, tempDir } from "./helpers";

const GOLDEN_BRIEF = [
  "# DEMO-1 · Fix it",
  "",
  "下面的标题、描述和验收标准是卡片的当前内容，已包含主人采纳的全部改动，以它们为准：后文的计划或交接内容与之不一致时，按卡片执行。",
  "",
  "## 描述",
  "desc",
  "",
  "## 验收标准",
  "works",
  "",
  "## 参考图片",
  "无。",
  "",
  "## 最近备注",
  "无。",
  "",
  "## 项目",
  "- 名称：Demo",
  "- 类型：web",
  "",
  "## 项目记忆",
  "项目目标、规则和当前状态都在 `.vibe/` 目录（先读 `.vibe/INDEX.md` 和 `.vibe/PROJECT_STATE.md`；主人的规则在 `.vibe/instructions/`）。这些文件是权威依据，对你只读：需要修改时请在卡片评论里说明，不要自己改。",
  "",
  "## 回报约定",
  "你是卡片 DEMO-1 的执行者。用 `vibe-board show DEMO-1`（MCP 工具 `vibe_show`）读取卡片。用 `vibe-board comment DEMO-1 --body \"...\"` 汇报进展或提问。用 `vibe-board attachment add DEMO-1 --file <path>` 上传结果文件。本轮结束前，把完成的工作提交到工作树分支（批准后看板会合并该分支，不会处理未提交的改动）。你不能移动卡片：本轮结束时若没有未解决的提问，看板会把卡片移到“验证中”（verifying）。",
  "",
  "## 预设指令",
  "Be careful.",
  "",
].join("\n");

function setup() {
  const ctx = setupBoard();
  const { board, runtime } = ctx;
  const prompts = createBoardPrompts(runtime.store);
  prompts.register({ pruneMissing: true });
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "d:/repo/demo/", projectType: "web" });
  const { project: other } = board.projects.create({ name: "Other", prefix: "OTH", repoPath: "d:/repo/other/", projectType: "web" });
  const { preset } = board.presets.create({
    name: "codex-high",
    provider: "codex",
    model: "gpt-5",
    permissionMode: "full",
    environmentKind: "new-worktree",
    runtimeEnv: "web-dev-server",
    instructions: "Be careful.",
  });
  const { card } = board.cards.create({ project: project.prefix, title: "Fix it", column: "todo", presetId: preset.id, acceptance: "works", description: "desc" });
  return { ...ctx, prompts, project, other, preset, card, store: board.store };
}
type T = ReturnType<typeof setup>;
const brief = (t: T, extra: Record<string, unknown> = {}) =>
  buildDispatchBrief({ card: t.card, project: t.project, preset: t.preset, events: [], prompts: t.prompts, ...extra });

describe("prompt defaults", () => {
  it("every def registers and renders without the database", () => {
    const t = setup();
    expect(t.store.prompts.list().map((p) => p.key).sort()).toEqual(BOARD_PROMPT_DEFS.map((d) => d.key).sort());
    expect(BOARD_PROMPT_DEFS.every((d) => d.plugin === "vibe-board")).toBe(true);
    expect(defaultPrompts.resolve("board.watchdog_continue")).toBe(CONTINUE_PROMPT);
    expect(SCOUT_SYSTEM_PROMPT).toContain("最多 20 行");
    expect(defaultPrompts.resolve("board.port_hint", { vars: { port: "4100" } })).toContain("端口 4100");
  });
});

describe("brief through the registry", () => {
  const card = { key: "DEMO-1", title: "Fix it", description: "desc", acceptance: "works", refImages: [], projectId: "p" };
  const fixed = { project: { name: "Demo", projectTypes: ["web"] }, preset: { instructions: "Be careful.", runtimeEnv: "" } };

  it("default output is the exact historical brief", () => {
    expect(buildDispatchBrief({ ...fixed, card, events: [] } as never)).toBe(GOLDEN_BRIEF);
    const t = setup();
    expect(brief(t, { card: card as never, project: fixed.project as never, preset: fixed.preset as never })).toBe(GOLDEN_BRIEF);
  });

  it("a global override replaces the skeleton; a project override wins; segments drop out when omitted", () => {
    const t = setup();
    t.store.prompts.setOverride("board.brief", "TASK {{card.key}} / {{card.title}}\n{{description}}");
    expect(brief(t)).toBe("TASK DEMO-1 / Fix it\n## 描述\ndesc\n");
    t.store.prompts.setOverride("board.brief", "OTHER {{card.key}}", { projectId: t.project.id });
    expect(brief(t)).toBe("OTHER DEMO-1\n");
    t.store.prompts.clearOverride("board.brief", { projectId: t.project.id });
    expect(brief(t)).toBe("TASK DEMO-1 / Fix it\n## 描述\ndesc\n");
  });

  it("a card description containing a placeholder is not rendered again", () => {
    const t = setup();
    const out = brief(t, { card: { ...t.card, description: "see {{card.key}}" } });
    expect(out).toContain("see {{card.key}}");
  });

  it("the contract text is its own prompt and is project-scoped", () => {
    const t = setup();
    t.store.prompts.setOverride("board.brief_contract", "Report with {{card.key}} only.", { projectId: t.project.id });
    expect(brief(t)).toContain("## 回报约定\nReport with DEMO-1 only.\n");
    const otherCard = t.board.cards.create({ project: t.other.prefix, title: "o", column: "todo" }).card;
    expect(brief(t, { card: otherCard, project: t.other })).toContain("你是卡片 OTH-1 的执行者。");
  });

  it("limits come from the settings values", () => {
    const t = setup();
    for (let i = 1; i <= 4; i++) {
      t.store.events.add({ cardId: t.card.id, type: "note", authorKind: "agent", author: "w", body: { text: `note ${i}` } });
      t.store.events.add({ cardId: t.card.id, type: "chat", authorKind: "user", author: "u", body: { text: `chat ${i}` } });
    }
    const events = t.store.events.list(t.card.id);
    const out = brief(t, { events, limits: { recentEvents: 2, chatLimit: 1 } });
    expect(out).toMatch(/note 3[\s\S]*note 4/);
    expect(out).not.toContain("note 2");
    expect(out).toContain("chat 4");
    expect(out).not.toContain("chat 3");
    expect(brief(t, { events, limits: { chatLimit: 0 } })).not.toContain("群聊");
    const handoff = { path: null, text: "y".repeat(900) };
    expect(brief(t, { handoff, limits: { handoffMaxChars: 500 } })).toContain("（已截断，见文件）");
    expect(brief(t, { handoff })).not.toContain("（已截断");
  });

  it("settings defaults and ranges", () => {
    const v = boardSettings.schema.parse({});
    expect(v).toMatchObject({
      briefRecentEvents: 5,
      briefChatLimit: 8,
      briefHandoffMaxChars: 8000,
      scoutCacheTtlMinutes: 10,
      scoutSummaryMaxLines: 20,
      scoutMaxTasksPerCall: 16,
      watchdogPollSeconds: 30,
    });
    expect(boardSettings.schema.safeParse({ briefRecentEvents: 0 }).success).toBe(false);
    expect(boardSettings.schema.safeParse({ scoutCacheTtlMinutes: 0 }).success).toBe(true);
  });
});

describe("other prompt keys", () => {
  it("port hint and takeover texts render their placeholders", async () => {
    const t = setup();
    t.store.prompts.setOverride("board.port_hint", "Use port {{port}}.");
    const calls: unknown[] = [];
    const consumer = startAdmissionConsumer({
      db: t.runtime.db,
      board: t.board,
      dispatcher: { dispatch: (async (_id: string, opts: unknown) => void calls.push(opts)) as never },
      prompts: t.prompts,
      pollIntervalMs: 20,
    });
    t.store.projects.get(t.project.id);
    const { publishEvent } = await import("../server/vibe/db");
    publishEvent(t.runtime.db, {
      type: "scheduler.admitted",
      cardId: t.card.id,
      projectId: t.project.id,
      payload: { cardId: t.card.id, port: 4100 },
    } as never);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await consumer.stop();
    expect(calls[0]).toMatchObject({ extraInstructions: "Use port 4100." });
  });

  it("the takeover and nudge prompts reach the failover agent", async () => {
    const t = setup();
    t.store.prompts.setOverride("board.takeover", "TAKE {{provider}} {{category}} {{message}}\n{{transcriptPath}}");
    t.store.prompts.setOverride("board.takeover_nudge", "GO {{card.key}} after {{provider}}/{{category}}");
    const fb = t.board.presets.create({ name: "fb", provider: "claude", model: "sonnet" }).preset;
    t.store.presets.update(t.preset.id, { fallbackPresetIds: [fb.id] });
    const created: any[] = [];
    const sent: string[] = [];
    const paseo = {
      workspaces: { ref: () => ({ refresh: async () => ({}), agents: { create: async (o: any) => void created.push(o) } }) },
      agents: {
        ref: () => ({
          timeline: { refetch: async () => ({ entries: [], hasOlder: false }) },
          send: async (m: string) => void sent.push(m),
        }),
      },
    } as never;
    const failure = { message: "quota gone", category: "quota" } as never;
    const start = (n: number) => {
      const c = t.board.cards.create({ project: t.project.prefix, title: `c${n}`, column: "todo", presetId: t.preset.id }).card;
      const { session } = t.store.cards.dispatch({ cardId: c.id, agentId: `old-${n}`, workspaceId: "ws1", provider: "codex", worktree: null, presetId: t.preset.id });
      t.store.sessions.setState(session.id, "working");
      return { c, session };
    };
    const one = start(1);
    const re = createReassigner({ board: t.board, getPaseo: () => paseo, prompts: t.prompts, newAgentId: () => "new-1", log: () => {} });
    expect((await re.reassign(one.session.id, failure)).reassigned).not.toBeNull();
    expect(created[0].prompt).toContain("TAKE codex quota quota gone\n上一个 agent 的转录文件");
    const two = start(2);
    const conv = createReassigner({ board: t.board, getPaseo: () => paseo, prompts: t.prompts, convert: async () => "converted", log: () => {} });
    expect((await conv.reassign(two.session.id, failure)).reassigned).not.toBeNull();
    expect(sent).toContain(`GO ${two.c.key} after codex/quota`);
  });

  it("scout prompts are editable and the summary length follows the setting", async () => {
    const t = setup();
    t.store.prompts.setOverride("board.scout_how.locate", "FIND IT");
    t.store.prompts.setOverride("board.scout_system", "SYS {{maxLines}}");
    const created: any[] = [];
    const prompts: string[] = [];
    const paseo = {
      agents: {
        create: async (o: any) => {
          created.push(o);
          return {
            run: async (p: string) => {
              prompts.push(p);
              return { status: "idle", lastMessage: ["a", "b", "c", "d", "e"].join("\n") };
            },
            archive: async () => {},
          };
        },
      },
    } as never;
    t.store.cards.update(t.card.id, {});
    const scout = createScoutService({
      board: t.board,
      getPaseo: () => paseo,
      getConfig: () => ({ preset: "codex-high", maxParallel: 1, timeoutMs: 1000, summaryMaxLines: 3, cacheTtlMs: 0, maxTasksPerCall: 1 }),
      headOf: async () => "h",
      platform: "linux",
      prompts: t.prompts,
    });
    const out = await scout.run(t.card.key, [{ goal: "where", paths: ["src", "lib"] }]);
    expect(created[0].config.systemPrompt).toBe("SYS 3");
    expect(prompts[0]).toBe("类型：locate。FIND IT\n目标：where\n限定范围：src, lib\n回复最多 3 行，并带 path:line 定位。");
    expect(out.results[0]!.summary).toBe("a\nb\nc\n... (2 more lines cut)");
    await expect(scout.run(t.card.key, [{ goal: "x" }, { goal: "y" }])).rejects.toThrow(/At most 1 tasks/);
    await scout.run(t.card.key, [{ goal: "where", paths: ["src", "lib"] }]); // ttl 0: no cache hit
    expect(created).toHaveLength(2);
    expect(trimSummary("1\n2\n3", 2)).toBe("1\n2\n... (1 more lines cut)");
  });

  it("the instructions marker is always code-added and injectBoard uses the given text", () => {
    const t = setup();
    expect(buildBoardInstructions()).toMatch(/^\[vibe-board\]\n# Vibe Board\n/);
    t.store.prompts.setOverride("board.instructions", "Custom board help");
    const text = buildBoardInstructions(t.prompts);
    expect(text).toBe(`${BOARD_INSTRUCTIONS_MARKER}\nCustom board help`);
    const req = { config: { systemPrompt: "base" } };
    const injected = injectBoard(req, { instructions: true, cliAndMcp: false }, null, "node", () => text);
    expect(injected.config.systemPrompt).toBe(`base\n\n${text}`);
    expect(injectBoard(injected, { instructions: true, cliAndMcp: false }, null, "node", () => text).config.systemPrompt).toBe(
      injected.config.systemPrompt,
    );
    expect(injectBoard(req, { instructions: true, cliAndMcp: false }, null, "node").config.systemPrompt).toContain("# Vibe Board");
  });
});

describe("prompt RPCs", () => {
  function wired() {
    const t = setup();
    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    registerBoardRpcs({ handle: (def: { name: string }, fn: never) => handlers.set(def.name, fn) } as never, t.board);
    const call = async (def: { name: string; input: any; output: any }, input: unknown) =>
      def.output.parse(await handlers.get(def.name)!(def.input.parse(input), { paseo: {} }));
    return { ...t, call };
  }

  it("lists, sets, clears per scope and validates", async () => {
    const t = wired();
    const listed = await t.call(rpc.promptsListRpc, {});
    expect(listed.prompts.map((p: { key: string }) => p.key)).toContain("board.brief");
    expect(listed.projects.map((p: { prefix: string }) => p.prefix).sort()).toEqual(["DEMO", "OTH"]);

    await t.call(rpc.promptsSetRpc, { key: "board.watchdog_continue", text: "Keep going" });
    await t.call(rpc.promptsSetRpc, { key: "board.watchdog_continue", text: "Keep going here", projectId: t.project.id });
    const scoped = await t.call(rpc.promptsListRpc, { projectId: t.project.id });
    const row = scoped.prompts.find((p: { key: string }) => p.key === "board.watchdog_continue");
    expect(row).toMatchObject({ globalOverride: "Keep going", projectOverride: "Keep going here", source: "project", overriddenProjects: [t.project.id] });

    await t.call(rpc.promptsClearRpc, { key: "board.watchdog_continue", projectId: t.project.id });
    await t.call(rpc.promptsSetRpc, { key: "board.watchdog_continue", text: "   " }); // blank = clear
    const after = (await t.call(rpc.promptsListRpc, { projectId: t.project.id })).prompts.find(
      (p: { key: string }) => p.key === "board.watchdog_continue",
    );
    expect(after).toMatchObject({ globalOverride: null, projectOverride: null, source: "default" });

    await expect(t.call(rpc.promptsSetRpc, { key: "nope.nothing", text: "x" })).rejects.toThrow();
    await expect(t.call(rpc.promptsSetRpc, { key: "board.brief", text: "x".repeat(100_001) })).rejects.toThrow(/\[invalid\]/);
    await expect(t.call(rpc.promptsSetRpc, { key: "board.brief", text: "x", projectId: "missing" })).rejects.toThrow(/\[not_found\]/);
  });
});

describe("prompt sync (phone)", () => {
  const START = Date.parse("2026-03-01T08:00:00.000Z");
  function syncSetup() {
    const clock = { ms: START };
    const now = () => clock.ms;
    const runtime = openBoardRuntime({ path: join(tempDir(), "vibe.db"), now: () => new Date(clock.ms) });
    const { db, store } = runtime;
    createBoardPrompts(store).register({ pruneMissing: true });
    const sync = createSyncService({ db, store, now, log: () => {} });
    const project = store.projects.create({ name: "Demo", prefix: "DEM", repoPath: "/tmp/demo" });
    const client = new ClientSync({ deviceId: "phone-1", store: new MemoryChangeStore(), now });
    const transport = async (req: Parameters<typeof sync.exchange>[0]): Promise<ExchangeResponse> =>
      sync.exchange(JSON.parse(JSON.stringify(req)));
    const syncNow = () => client.sync(transport);
    const row = (table: string, id: string) => client.node.readRow(table, id)?.values;
    return { clock, store, project, client, syncNow, row, sync };
  }

  it("publishes templates and applies phone text edits, project scope first", async () => {
    const t = syncSetup();
    await t.syncNow();
    expect(t.row("prompt_template", "board.brief")?.default_text).toContain("{{card.key}}");

    t.clock.ms += 1000;
    t.client.write("prompt_override", promptOverrideId("board.watchdog_continue"), { text: "phone global" });
    t.client.write("prompt_override", promptOverrideId("board.watchdog_continue", t.project.id), { text: "phone project" });
    const out = await t.syncNow();
    expect(out.rejected).toEqual([]);
    expect(t.store.prompts.resolve("board.watchdog_continue")).toBe("phone global");
    expect(t.store.prompts.resolve("board.watchdog_continue", { projectId: t.project.id })).toBe("phone project");

    // the daemon edit flows back; writing blank text clears from the phone
    t.clock.ms += 1000;
    t.client.write("prompt_override", promptOverrideId("board.watchdog_continue", t.project.id), { text: "" });
    await t.syncNow();
    expect(t.store.prompts.resolve("board.watchdog_continue", { projectId: t.project.id })).toBe("phone global");

    t.clock.ms += 1000;
    t.store.prompts.setOverride("board.watchdog_continue", "desktop wins later");
    await t.syncNow();
    expect(t.row("prompt_override", promptOverrideId("board.watchdog_continue"))?.text).toBe("desktop wins later");
  });

  it("refuses unknown keys, deletes, template edits and bad scopes", async () => {
    const t = syncSetup();
    await t.syncNow();
    t.clock.ms += 1000;
    const forge = async (changes: unknown[]) => {
      const req = t.client.buildRequest();
      req.changes = changes as never;
      const resp = t.sync.exchange(req);
      return resp.ok ? resp.rejected.map((r) => r.reason) : [];
    };
    const hlc = () => t.client.node.clock.tick();
    const ov = (rowId: string, value: unknown, column = "text") => ({ kind: "field", table: "prompt_override", rowId, column, value, hlc: hlc() });
    expect(await forge([ov(promptOverrideId("no.such_key"), "x")])).toEqual(["read_only"]);
    expect(await forge([ov(promptOverrideId("board.brief", "missing-project"), "x")])).toEqual(["read_only"]);
    expect(await forge([ov("board.brief", "x")])).toEqual(["read_only"]);
    expect(await forge([ov(promptOverrideId("board.brief"), 5)])).toEqual(["read_only"]);
    expect(await forge([ov(promptOverrideId("board.brief"), "x".repeat(100_001))])).toEqual(["read_only"]);
    expect(await forge([{ kind: "delete", table: "prompt_override", rowId: promptOverrideId("board.brief"), hlc: hlc() }])).toEqual(["read_only"]);
    expect(await forge([{ kind: "field", table: "prompt_template", rowId: "board.brief", column: "default_text", value: "evil", hlc: hlc() }])).toEqual(["read_only"]);
    expect(t.store.prompts.resolve("board.watchdog_continue")).toBe(defaultPrompts.resolve("board.watchdog_continue"));
    expect(parsePromptOverrideId(promptOverrideId("board.brief", t.project.id))).toEqual({ key: "board.brief", projectId: t.project.id });
  });
});
