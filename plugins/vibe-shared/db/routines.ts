import { randomUUID } from "node:crypto";
import { RoutineCreateSchema, RoutinePatchSchema, RoutineSchema, type RoutineCreate, type RoutinePatch } from "../contract/routines";
import { nextRoutineTime } from "../contract/routine-schedule";
import { decodeRow } from "./rows";
import type { VibeDb } from "./sqlite";

export function createRoutineStore(db: VibeDb, now = () => new Date()) {
  function get(id: string) {
    const row = db.prepare("SELECT * FROM bot_routine WHERE id=?").get(id);
    return row ? decodeRow(RoutineSchema, { ...row, quiet: !!row.quiet, paused: !!row.paused }) : null;
  }
  function requireRoutine(id: string) { const r = get(id); if (!r) throw new Error("例程不存在"); return r; }
  function list(botId?: string) {
    const rows = botId ? db.prepare<{id:string}>("SELECT id FROM bot_routine WHERE bot_id=? ORDER BY created_at,id").all(botId) : db.prepare<{id:string}>("SELECT id FROM bot_routine ORDER BY created_at,id").all();
    return rows.map((row) => requireRoutine(row.id));
  }
  function create(input: RoutineCreate) {
    const value = RoutineCreateSchema.parse(input); const at = now();
    const next = nextRoutineTime(value.schedule, value.timezone, at).toISOString(); const id = "routine_" + randomUUID();
    db.prepare("INSERT INTO bot_routine(id,bot_id,title,schedule_json,timezone,prompt,target,quiet,paused,missed_policy,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)").run(id,value.botId,value.title,JSON.stringify(value.schedule),value.timezone,value.prompt,value.target,Number(value.quiet),value.missedPolicy,next,at.toISOString(),at.toISOString());
    return requireRoutine(id);
  }
  function update(id: string, patch: RoutinePatch) {
    const old = requireRoutine(id); const value = RoutinePatchSchema.parse(patch); const merged = { ...old, ...value }; const at = now();
    const next = value.schedule || value.timezone ? nextRoutineTime(merged.schedule, merged.timezone, at).toISOString() : old.nextRunAt;
    db.prepare("UPDATE bot_routine SET title=?,schedule_json=?,timezone=?,prompt=?,target=?,quiet=?,missed_policy=?,next_run_at=?,updated_at=? WHERE id=?").run(merged.title,JSON.stringify(merged.schedule),merged.timezone,merged.prompt,merged.target,Number(merged.quiet),merged.missedPolicy,next,at.toISOString(),id);
    return requireRoutine(id);
  }
  function pause(id: string) { requireRoutine(id); db.prepare("UPDATE bot_routine SET paused=1,updated_at=? WHERE id=?").run(now().toISOString(),id); return requireRoutine(id); }
  function resume(id: string) { const r = requireRoutine(id); const at = now(); const next = r.missedPolicy === "run_once" && r.nextRunAt && r.nextRunAt <= at.toISOString() ? r.nextRunAt : nextRoutineTime(r.schedule,r.timezone,at).toISOString(); db.prepare("UPDATE bot_routine SET paused=0,next_run_at=?,updated_at=? WHERE id=?").run(next,at.toISOString(),id); return requireRoutine(id); }
  function remove(id: string) { requireRoutine(id); db.prepare("DELETE FROM bot_routine WHERE id=?").run(id); }
  function runNow(id: string) { requireRoutine(id); const at = now().toISOString(); db.prepare("INSERT INTO bot_routine_run(id,routine_id,scheduled_at,status) VALUES(?,?,?,?)").run("run_"+randomUUID(),id,at,"queued"); }
  return { get, list, create, update, pause, resume, delete: remove, runNow };
}
