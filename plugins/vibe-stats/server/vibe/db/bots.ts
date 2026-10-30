// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { randomUUID } from "node:crypto";
import {
  BotCreateSchema,
  BotMemorySchema,
  BotPatchSchema,
  BotSchema,
  type Bot,
  type BotCreate,
  type BotMemory,
  type BotPatch,
} from "../contract/bots";
import { decodeRow } from "./rows";
import type { VibeDb, SqlParam } from "./sqlite";

export function createBotStore(db: VibeDb, now = () => new Date().toISOString()) {
  function get(id: string): Bot | null {
    const row = db.prepare("SELECT * FROM bot WHERE id=?").get(id);
    return row ? decodeRow(BotSchema, { ...row, pending_model: !!row.pending_model }) : null;
  }

  function requireBot(id: string): Bot {
    const bot = get(id);
    if (!bot) throw new Error("bot 不存在");
    return bot;
  }

  function list(
    filter: { kind?: Bot["kind"]; projectId?: string; includeArchived?: boolean } = {},
  ) {
    return db
      .prepare<{ id: string }>("SELECT id FROM bot ORDER BY created_at,id")
      .all()
      .map((row) => requireBot(row.id))
      .filter((bot) =>
        (!filter.kind || bot.kind === filter.kind) &&
        (!filter.projectId || bot.projectId === filter.projectId) &&
        (filter.includeArchived || !bot.archivedAt),
      );
  }

  function create(input: BotCreate, mainAgentId: string | null = null): Bot {
    const value = BotCreateSchema.parse(input);
    const id = "bot_" + randomUUID();
    const at = now();
    db.prepare(`INSERT INTO bot(
      id,kind,project_id,name,title,avatar_seed,avatar_hue,avatar_path,instructions,
      preset_id,provider,model,thinking,backup_models_json,notifications_json,
      permission_mode,main_agent_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      value.kind,
      value.projectId,
      value.name,
      value.title,
      value.avatarSeed || id,
      value.avatarHue,
      value.avatarPath,
      value.instructions,
      value.presetId,
      value.provider,
      value.model,
      value.thinking,
      JSON.stringify(value.backupModels),
      JSON.stringify(value.notifications),
      value.permissionMode,
      mainAgentId,
      at,
      at,
    );
    return requireBot(id);
  }

  function update(id: string, patch: BotPatch): Bot {
    const value = BotPatchSchema.parse(patch);
    requireBot(id);
    const fields: Record<string, string> = {
      name: "name",
      title: "title",
      avatarSeed: "avatar_seed",
      avatarHue: "avatar_hue",
      avatarPath: "avatar_path",
      instructions: "instructions",
      presetId: "preset_id",
      provider: "provider",
      model: "model",
      thinking: "thinking",
      backupModels: "backup_models_json",
      notifications: "notifications_json",
      permissionMode: "permission_mode",
    };
    const assignments: string[] = [];
    const params: SqlParam[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      assignments.push(fields[key] + "=?");
      params.push(typeof item === "object" && item !== null ? JSON.stringify(item) : item);
    }
    if (assignments.length) {
      db.prepare(`UPDATE bot SET ${assignments.join(",")},updated_at=? WHERE id=?`).run(...params, now(), id);
    }
    return requireBot(id);
  }

  function setMain(id: string, agentId: string) {
    requireBot(id);
    db.prepare("UPDATE bot SET main_agent_id=?,pending_model=0,updated_at=? WHERE id=?").run(
      agentId,
      now(),
      id,
    );
  }

  function pending(id: string, value: boolean) {
    db.prepare("UPDATE bot SET pending_model=?,updated_at=? WHERE id=?").run(value ? 1 : 0, now(), id);
  }

  function defaultGet(projectId: string): string | null {
    return (
      db.prepare<{ default_bot_id: string }>(
        "SELECT default_bot_id FROM project_default_bot WHERE project_id=?",
      ).get(projectId)?.default_bot_id ?? null
    );
  }

  function defaultSet(projectId: string, botId: string) {
    const bot = requireBot(botId);
    if (bot.kind !== "project" || bot.projectId !== projectId || bot.archivedAt) {
      throw new Error("默认 bot 必须属于本项目且未归档");
    }
    db.prepare(`INSERT INTO project_default_bot(project_id,default_bot_id) VALUES(?,?)
      ON CONFLICT(project_id) DO UPDATE SET default_bot_id=excluded.default_bot_id`)
      .run(projectId, botId);
  }

  function archive(id: string) {
    db.immediate(() => {
      const bot = requireBot(id);
      if (bot.role === "coordinator") throw new Error("总协调不能归档；请先把总协调角色转给另一个独立 bot");
      if (bot.projectId && defaultGet(bot.projectId) === id) {
        const next = list({ projectId: bot.projectId }).find((item) => item.id !== id);
        if (!next) throw new Error("请先创建另一个项目 bot，再归档默认 bot");
        defaultSet(bot.projectId, next.id);
      }
      db.prepare("UPDATE bot SET archived_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
    });
  }

  function coordinator(): Bot | null {
    const row = db.prepare<{ id: string }>("SELECT id FROM bot WHERE role='coordinator'").get();
    return row ? requireBot(row.id) : null;
  }

  /** Moves the unique coordinator role; the previous holder keeps its name and settings. */
  function transferCoordinator(toId: string): Bot {
    return db.immediate(() => {
      const target = requireBot(toId);
      if (target.kind !== "independent" || target.archivedAt) throw new Error("总协调只能转给未归档的独立 bot");
      if (target.role === "coordinator") throw new Error("该 bot 已经是总协调");
      db.prepare("UPDATE bot SET role=NULL,updated_at=? WHERE role='coordinator'").run(now());
      db.prepare("UPDATE bot SET role='coordinator',updated_at=? WHERE id=?").run(now(), toId);
      return requireBot(toId);
    });
  }

  /** Migration helper: promotes `id` only while no coordinator exists, so reruns and transfers are respected. */
  function ensureCoordinator(id: string, defaults: { name: string; title: string; instructions: string }): Bot {
    return db.immediate(() => {
      const bot = requireBot(id);
      if (coordinator()) return bot;
      // updated_at stays untouched: the legacy settings snapshot only applies to bots never edited.
      db.prepare("UPDATE bot SET role='coordinator',name=?,title=?,instructions=? WHERE id=?").run(
        bot.name === "助手" ? defaults.name : bot.name,
        bot.title || defaults.title,
        bot.instructions || defaults.instructions,
        id,
      );
      return requireBot(id);
    });
  }

  function legacy(source: string, input: BotCreate, agentId: string | null) {
    return db.immediate(() => {
      const previous = db
        .prepare<{ bot_id: string }>("SELECT bot_id FROM bot_legacy_migration WHERE source=?")
        .get(source);
      if (previous) return requireBot(previous.bot_id);
      const bot = create(input, agentId);
      db.prepare("INSERT INTO bot_legacy_migration(source,bot_id) VALUES(?,?)").run(source, bot.id);
      if (bot.projectId && !defaultGet(bot.projectId)) defaultSet(bot.projectId, bot.id);
      return bot;
    });
  }

  function memories(botId: string): BotMemory[] {
    requireBot(botId);
    return db
      .prepare("SELECT * FROM bot_memory WHERE bot_id=? ORDER BY pinned DESC,updated_at DESC,id")
      .all(botId)
      .map((row) => BotMemorySchema.parse({
        ...row,
        botId: row.bot_id,
        pinned: !!row.pinned,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  function memoryAdd(
    botId: string,
    text: string,
    pinned = false,
    source: BotMemory["source"] = "user",
  ) {
    requireBot(botId);
    const at = now();
    const memory = BotMemorySchema.parse({
      id: "mem_" + randomUUID(),
      botId,
      text,
      pinned,
      source,
      createdAt: at,
      updatedAt: at,
    });
    db.prepare(`INSERT INTO bot_memory(id,bot_id,text,pinned,source,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(memory.id, botId, memory.text, pinned ? 1 : 0, source, at, at);
    return memory;
  }

  function memoryUpdate(botId: string, id: string, patch: { text?: string; pinned?: boolean }) {
    const previous = memories(botId).find((row) => row.id === id);
    if (!previous) throw new Error("记忆不存在或不属于当前 bot");
    const value = BotMemorySchema.parse({ ...previous, ...patch, updatedAt: now() });
    db.prepare("UPDATE bot_memory SET text=?,pinned=?,updated_at=? WHERE id=? AND bot_id=?").run(
      value.text,
      value.pinned ? 1 : 0,
      value.updatedAt,
      id,
      botId,
    );
    return value;
  }

  function memoryRemove(botId: string, id: string) {
    requireBot(botId);
    if (!db.prepare("DELETE FROM bot_memory WHERE bot_id=? AND id=?").run(botId, id).changes) {
      throw new Error("记忆不存在或不属于当前 bot");
    }
  }

  return {
    get,
    require: requireBot,
    list,
    create,
    update,
    setMain,
    pending,
    archive,
    coordinator,
    transferCoordinator,
    ensureCoordinator,
    legacy,
    defaultGet,
    defaultSet,
    memories,
    memoryAdd,
    memoryUpdate,
    memoryRemove,
  };
}
export type BotStore = ReturnType<typeof createBotStore>;
