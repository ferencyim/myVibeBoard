import { afterEach, describe, expect, it } from "vitest";
import { createBotStore } from "../server/vibe/db/bots";
import { migrateOwner } from "../server/vibe/db/migrate";
import { openVibeDb, type VibeDb } from "../server/vibe/db/sqlite";
import { assertCreationScope, assertPermissionTightening, memoryContext } from "../server/service";
import { BotPatchSchema } from "../server/vibe/contract/bots";

const databases: VibeDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = openVibeDb({ path: ":memory:" });
  databases.push(db);
  migrateOwner(db, "vibe-bots");
  const bots = createBotStore(db);
  return { db, bots };
}

describe("bot 身份与无损迁移", () => {
  it("部分更新只解析已提供字段，不用创建默认值覆盖已有资料", () => {
    const { bots } = setup();
    const bot = bots.create({
      kind: "independent", name: "助手", title: "长期队友", avatarSeed: "custom-seed",
      avatarHue: 42, avatarPath: "/avatar.png", instructions: "保留角色说明",
      provider: "codex", model: "initial", thinking: "high", presetId: "my-preset",
      backupModels: [{ provider: "claude", model: "backup", thinking: "" }],
      notifications: { enabled: false, completed: false, failed: true }, permissionMode: "full",
    });
    expect(BotPatchSchema.parse({})).toEqual({});
    expect(BotPatchSchema.parse({ model: "replacement" })).toEqual({ model: "replacement" });
    expect(bots.update(bot.id, { model: "replacement" })).toEqual({
      ...bot, model: "replacement", updatedAt: bots.require(bot.id).updatedAt,
    });
    expect(BotPatchSchema.parse({ provider: null, model: null, instructions: "" })).toEqual({
      provider: null, model: null, instructions: "",
    });
    expect(() => BotPatchSchema.parse({ unexpected: true })).toThrow();
    expect(() => BotPatchSchema.parse({ avatarHue: 360 })).toThrow();
  });

  it("owner 迁移及旧会话收编幂等，保留 agent 和用户编辑", () => {
    const { db, bots } = setup();
    const first = bots.legacy("master", { kind: "independent", name: "助手" }, "old-agent");
    bots.update(first.id, { name: "我的助理", instructions: "保留说明" });
    bots.memoryAdd(first.id, "优先解释原因", true);
    expect(migrateOwner(db, "vibe-bots").applied).toEqual([]);
    const second = bots.legacy("master", { kind: "independent", name: "助手" }, "another-agent");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("我的助理");
    expect(second.mainAgentId).toBe("old-agent");
    expect(bots.memories(second.id)).toHaveLength(1);
    expect(bots.list()).toHaveLength(1);
  });

  it("支持多个独立 bot 与多个项目 bot，默认只允许本项目有效 bot", () => {
    const { bots } = setup();
    bots.create({ kind: "independent", name: "助手" });
    bots.create({ kind: "independent", name: "第二助理" });
    const first = bots.legacy("project:a", { kind: "project", projectId: "a", name: "项目 bot" }, "project-agent");
    const second = bots.create({ kind: "project", projectId: "a", name: "设计助理" });
    const other = bots.create({ kind: "project", projectId: "b", name: "其他项目" });
    expect(bots.list({ kind: "independent" })).toHaveLength(2);
    expect(bots.list({ projectId: "a" })).toHaveLength(2);
    expect(bots.defaultGet("a")).toBe(first.id);
    expect(() => bots.defaultSet("a", other.id)).toThrow("本项目");
    bots.defaultSet("a", second.id);
    bots.archive(second.id);
    expect(bots.defaultGet("a")).toBe(first.id);
    expect(bots.list({ projectId: "a" })).toHaveLength(1);
    expect(() => bots.archive(first.id)).toThrow("另一个项目 bot");
  });

  it("主会话更新保留 bot 身份、记忆与资料", () => {
    const { bots } = setup();
    const bot = bots.create({ kind: "independent", name: "助手" });
    bots.setMain(bot.id, "old-agent");
    bots.memoryAdd(bot.id, "使用中文");
    bots.update(bot.id, { provider: "claude", model: "next-model" });
    bots.pending(bot.id, true);
    expect(bots.require(bot.id).pendingModel).toBe(true);
    bots.setMain(bot.id, "new-agent");
    expect(bots.require(bot.id)).toMatchObject({ id: bot.id, name: "助手", mainAgentId: "new-agent", pendingModel: false });
    expect(bots.memories(bot.id)[0]?.text).toBe("使用中文");
  });
});

describe("个人记忆与工具权限", () => {
  it("记忆增改删按 bot 隔离，置顶优先且注入不超预算", () => {
    const { bots } = setup();
    const first = bots.create({ kind: "independent", name: "一" });
    const other = bots.create({ kind: "independent", name: "二" });
    const plain = bots.memoryAdd(first.id, "普通经验".repeat(1000));
    const pinned = bots.memoryAdd(first.id, "总是先给结论", true, "bot");
    expect(() => bots.memoryUpdate(other.id, pinned.id, { text: "越权" })).toThrow("不属于");
    expect(() => bots.memoryRemove(other.id, pinned.id)).toThrow("不属于");
    bots.memoryUpdate(first.id, pinned.id, { text: "先给结论，再解释" });
    const context = memoryContext(bots.memories(first.id));
    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context).toContain("[置顶] 先给结论，再解释");
    expect(context.indexOf("先给结论")).toBeLessThan(context.indexOf("普通经验"));
    expect(context).toContain("已截断");
    bots.memoryRemove(first.id, plain.id);
    expect(bots.memories(first.id)).toHaveLength(1);
    expect(bots.memories(other.id)).toEqual([]);
  });

  it("项目 bot 不能创建别的项目或独立 bot，不能放宽权限", () => {
    const { bots } = setup();
    const caller = bots.create({ kind: "project", projectId: "a", name: "项目 bot" });
    expect(() => assertCreationScope(caller, { kind: "project", projectId: "a", name: "同伴" })).not.toThrow();
    expect(() => assertCreationScope(caller, { kind: "project", projectId: "b", name: "越权" })).toThrow("本项目");
    expect(() => assertCreationScope(caller, { kind: "independent", name: "越权" })).toThrow("本项目");
    expect(() => assertPermissionTightening("accept-edits", "full")).toThrow("不能放宽");
    expect(() => assertPermissionTightening("full", "accept-edits")).not.toThrow();
    expect(() => assertPermissionTightening("auto", "auto")).not.toThrow();
  });
});
