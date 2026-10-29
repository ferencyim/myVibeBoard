import { randomUUID } from "node:crypto";
import { BotThreadSchema } from "../contract/bot-thread";
import { decodeRow } from "./rows";
import type { VibeDb } from "./sqlite";

export function createBotThreadStore(db: VibeDb) {
  function list(botId: string) {
    return db.prepare("SELECT * FROM bot_thread WHERE bot_id=? AND archived_at IS NULL ORDER BY created_at,id")
      .all(botId).map((row) => decodeRow(BotThreadSchema, row));
  }
  function requireThread(botId: string, id: string) {
    const row = db.prepare("SELECT * FROM bot_thread WHERE bot_id=? AND id=?").get(botId, id);
    if (!row) throw new Error("旁线程不存在或不属于当前 bot");
    return decodeRow(BotThreadSchema, row);
  }
  function create(botId: string, title: string) {
    return db.immediate(() => {
      const bot = db.prepare<{ archived_at: string | null }>("SELECT archived_at FROM bot WHERE id=?").get(botId);
      if (!bot || bot.archived_at) throw new Error("bot 不存在或已归档");
      if (list(botId).length >= 8) throw new Error("未归档旁线程最多 8 个");
      const id = "thread_" + randomUUID();
      db.prepare("INSERT INTO bot_thread(id,bot_id,title,created_at) VALUES(?,?,?,?)")
        .run(id, botId, title, new Date().toISOString());
      return requireThread(botId, id);
    });
  }
  function rename(botId: string, id: string, title: string) {
    const thread = requireThread(botId, id);
    if (thread.archivedAt) throw new Error("旁线程已归档");
    db.prepare("UPDATE bot_thread SET title=? WHERE bot_id=? AND id=?").run(title, botId, id);
    return requireThread(botId, id);
  }
  function archive(botId: string, id: string) {
    requireThread(botId, id);
    db.prepare("UPDATE bot_thread SET archived_at=COALESCE(archived_at,?) WHERE bot_id=? AND id=?")
      .run(new Date().toISOString(), botId, id);
  }
  function setAgent(botId: string, id: string, agentId: string) {
    db.prepare("UPDATE bot_thread SET agent_id=? WHERE bot_id=? AND id=?").run(agentId, botId, id);
  }
  return { list, require: requireThread, create, rename, archive, setAgent };
}
