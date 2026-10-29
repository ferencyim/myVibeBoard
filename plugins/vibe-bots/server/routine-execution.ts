import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { BotService } from "./service";
import { nextRoutineTime } from "./vibe/contract/routine-schedule";
import { createRoutineStore } from "./vibe/db/routines";
import type { VibeDb } from "./vibe/db/sqlite";

interface Admission {
  paused: boolean;
  running: { total: number; byProvider: Record<string, number>; byProject: Record<string, number> };
  globalLimit: number;
  providerLimits: Record<string, number>;
  projectLimits: Record<string, number>;
  quota: Record<string, { level: string }>;
};
interface Run { id: string; routine_id: string; agent_id: string | null }

/** Scheduler calls tick serially; running rows survive daemon restarts. */
export function createRoutineExecution(db: VibeDb, service: BotService, server: PluginServerContext) {
  const routines = createRoutineStore(db);
  let busy = false;
  let recovered = false;

  function finish(run: Run, error: string | null) {
    const at = new Date().toISOString();
    const routine = routines.get(run.routine_id);
    if (!routine) return;
    const status = error ? "failed" : "completed";
    db.immediate(() => {
      db.prepare("UPDATE bot_routine_run SET status=?,error=?,finished_at=? WHERE id=? AND status='running'").run(status, error, at, run.id);
      db.prepare("UPDATE bot_routine SET last_status=?,last_error=?,updated_at=? WHERE id=?").run(status, error, at, routine.id);
    });
    const bot = service.bots.require(routine.botId);
    if (error || (!routine.quiet && bot.notifications.enabled && bot.notifications.completed)) {
      server.notify({ title: bot.name, body: error ? `例程「${routine.title}」失败：${error}` : `例程「${routine.title}」已完成。`, data: { botId: bot.id, ...(run.agent_id ? { agentId: run.agent_id } : {}) }, ...(run.agent_id ? { agentAttention: { agentId: run.agent_id, reason: error ? "error" as const : "finished" as const } } : {}) });
    }
  }

  async function recover() {
    for (const run of db.prepare<Run>("SELECT id,routine_id,agent_id FROM bot_routine_run WHERE status='running'").all()) {
      if (!run.agent_id) { finish(run, "服务重启中断了例程启动"); continue; }
      try {
        const handle = server.paseo.agents.ref(run.agent_id);
        await handle.refresh();
        const agent = handle.current();
        if (!agent || !agent.activeTurn) finish(run, "服务重启后无法确认例程结果");
      } catch { /* Keep the reservation until the host can be inspected. */ }
    }
    const now = new Date();
    for (const routine of routines.list()) {
      if (!routine.paused && routine.missedPolicy === "skip" && routine.nextRunAt && routine.nextRunAt < now.toISOString()) {
        db.prepare("UPDATE bot_routine SET next_run_at=?,updated_at=? WHERE id=?").run(nextRoutineTime(routine.schedule, routine.timezone, now).toISOString(), now.toISOString(), routine.id);
      }
    }
    recovered = true;
  }

  function withinLimits(admission: Admission, provider: string, projectId: string | null) {
    const limit = admission.providerLimits[provider];
    if (limit !== undefined && (admission.running.byProvider[provider] ?? 0) >= limit) return false;
    if (admission.quota[provider]?.level === "exhausted") return false;
    const projectLimit = projectId ? admission.projectLimits[projectId] : undefined;
    return !(projectId && projectLimit !== undefined && (admission.running.byProject[projectId] ?? 0) >= projectLimit);
  }

  async function processCandidates(admission: Admission) {
      const now = new Date();
      const queued = db.prepare<Run>("SELECT id,routine_id,agent_id FROM bot_routine_run WHERE status='queued' ORDER BY scheduled_at,id").all();
      const due = routines.list().filter((r) => !r.paused && r.nextRunAt && r.nextRunAt <= now.toISOString());
      const candidates = [...queued.map((run) => ({ run, routine: routines.get(run.routine_id) })), ...due.map((routine) => ({ run: null, routine }))];
      for (const { run, routine } of candidates) {
        if (!routine || routine.paused) continue;
        const bot = service.bots.require(routine.botId);
        if (bot.archivedAt) continue;
        if (db.prepare("SELECT id FROM bot_routine_run WHERE routine_id=? AND status='running'").get(routine.id)) continue;
        let opened: Awaited<ReturnType<typeof service.waitOpen>>;
        try { opened = await service.waitOpen(bot.id); }
        catch (error) {
          console.error("vibe-bots: 无法打开例程主对话", error);
          continue;
        }
        const main = server.paseo.agents.ref(opened.agentId);
        await main.refresh();
        const current = main.current();
        if (!current || (routine.target === "main" && current.activeTurn)) continue;
        const provider = current.provider;
        if (!withinLimits(admission, provider, bot.projectId)) continue;
        const id = run?.id ?? "run_" + randomUUID();
        const scheduled = routine.nextRunAt ?? now.toISOString();
        db.immediate(() => {
          if (!run) {
            db.prepare("INSERT INTO bot_routine_run(id,routine_id,scheduled_at,status) VALUES(?,?,?,'queued')").run(id, routine.id, scheduled);
            db.prepare("UPDATE bot_routine SET next_run_at=? WHERE id=?").run(nextRoutineTime(routine.schedule, routine.timezone, now).toISOString(), routine.id);
          }
          db.prepare("UPDATE bot_routine_run SET status='running',started_at=?,agent_id=?,provider=? WHERE id=?").run(now.toISOString(), routine.target === "main" ? opened.agentId : null, provider, id);
          db.prepare("UPDATE bot_routine SET last_run_at=?,last_status='running',last_error=NULL,updated_at=? WHERE id=?").run(now.toISOString(), now.toISOString(), routine.id);
        });
        void (async () => {
        let agentId = opened.agentId;
        try {
          let target = main;
          if (routine.target === "new_thread") {
            const thread = service.threads.create(bot.id, routine.title);
            const openedThread = await service.waitThread(bot.id, thread.id);
            agentId = openedThread.agentId;
            target = server.paseo.agents.ref(agentId);
            await target.refresh();
            if (target.current()?.provider !== provider) throw new Error("旁线程模型与已准入的 provider 不一致，请重试");
            db.prepare("UPDATE bot_routine_run SET agent_id=? WHERE id=?").run(agentId, id);
          }
          await target.send(routine.prompt, { sourceAgentId: agentId, messageId: id });
        } catch (error) { finish({ id, routine_id: routine.id, agent_id: agentId }, error instanceof Error ? error.message : String(error)); }
        })();
        return { started: true };
      }
      return { started: false };
  }

  async function tick(admission: Admission) {
    if (busy) return { started: false };
    busy = true;
    try {
      await service.ready();
      if (!recovered) await recover();
      if (admission.paused || admission.running.total >= admission.globalLimit) return { started: false };
      return await processCandidates(admission);
    } finally { busy = false; }
  }

  async function turnEnded(agentId: string, turnId: string | null, error: string | null) {
    const run = db.prepare<Run>("SELECT id,routine_id,agent_id FROM bot_routine_run WHERE agent_id=? AND status='running' ORDER BY started_at LIMIT 1").get(agentId);
    if (!run || !turnId) return false;
    try {
      const timeline = server.paseo.agents.ref(agentId).timeline;
      let history = await timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" });
      const seen = new Set<string>();
      for (;;) {
        const submitted = history.entries.find((entry) => entry.item.type === "user_message" && entry.item.clientMessageId === run.id);
        if (submitted) {
          if (submitted.turnId !== turnId) return false;
          finish(run, error);
          return true;
        }
        if (!history.hasOlder || !history.startCursor) return false;
        const cursor = history.startCursor;
        const key = `${cursor.epoch}:${cursor.seq}`;
        if (seen.has(key)) return false;
        seen.add(key);
        history = await timeline.refetch({ direction: "before", cursor, limit: 100, projection: "canonical" });
      }
    } catch {
      // Do not attribute an unrelated turn when history is unavailable.
      return false;
    }
  }
  function quiet(agentId: string) {
    const row = db.prepare<{ quiet: number }>("SELECT r.quiet FROM bot_routine_run x JOIN bot_routine r ON r.id=x.routine_id WHERE x.agent_id=? AND x.status='running' LIMIT 1").get(agentId);
    return !!row?.quiet;
  }
  return { tick, turnEnded, quiet };
}
