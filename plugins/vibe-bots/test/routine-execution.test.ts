import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createRoutineExecution } from "../server/routine-execution";
import type { BotService } from "../server/service";
import { createBotStore } from "../server/vibe/db/bots";
import { createBotThreadStore } from "../server/vibe/db/bot-threads";
import { migrateOwner } from "../server/vibe/db/migrate";
import { createRoutineStore } from "../server/vibe/db/routines";
import { openVibeDb, type VibeDb } from "../server/vibe/db/sqlite";

const databases: VibeDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openVibeDb({ path: ":memory:" });
  databases.push(db);
  migrateOwner(db, "vibe-bots");
  const bots = createBotStore(db);
  const threads = createBotThreadStore(db);
  const bot = bots.create({ kind: "project", projectId: "p", name: "助手", provider: "codex", model: "model" }, "agent");
  const routines = createRoutineStore(db);
  const routine = routines.create({ botId: bot.id, title: "检查", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", prompt: "检查", quiet: true });
  const send = vi.fn(async (_text: string, _options: { messageId?: string }) => {});
  const current = { provider: "codex", model: "model", activeTurn: null as object | null };
  const threadCurrent = { ...current };
  const refetch = vi.fn(async (_options: unknown) => ({ entries: [{ turnId: "routine-turn", item: { type: "user_message", clientMessageId: send.mock.calls[0]?.[1]?.messageId } }], hasOlder: false, startCursor: null as { epoch: string; seq: number } | null }));
  const handle = { id: "agent", refresh: vi.fn(async () => current), current: () => current, send,
    timeline: { refetch } };
  const notify = vi.fn();
  const server = { notify, paseo: { agents: { ref: (id: string) => ({ ...handle, id, current: () => id === "thread" ? threadCurrent : current }) } } } as unknown as PluginServerContext;
  const waitThread = vi.fn(async (botId: string, id: string) => { threads.setAgent(botId, id, "thread"); return { agentId: "thread" }; });
  const service = { bots, threads, waitThread, ready: async () => {}, waitOpen: async () => ({ agentId: "agent" }) } as unknown as BotService;
  const admission = { paused: false, running: { total: 0, byProvider: {}, byProject: {} }, globalLimit: 1, providerLimits: {}, projectLimits: {}, quota: {} };
  const execution = () => createRoutineExecution(db, service, server);
  const run = () => db.prepare<{ status: string; error: string | null; provider: string | null; agent_id: string | null }>("SELECT status,error,provider,agent_id FROM bot_routine_run ORDER BY scheduled_at DESC LIMIT 1").get();
  return { db, bot, threads, waitThread, routine, routines, execution, admission, current, threadCurrent, send, refetch, notify, run };
}

describe("例程执行", () => {
  it("准入受限时保留队列，恢复后按实际 provider 执行", async () => {
    const f = fixture();
    f.routines.runNow(f.routine.id);
    const engine = f.execution();
    expect(await engine.tick({ ...f.admission, running: { total: 1, byProvider: {}, byProject: {} } })).toEqual({ started: false });
    expect(f.run()?.status).toBe("queued");
    expect(await engine.tick({ ...f.admission, projectLimits: { p: 0 } })).toEqual({ started: false });
    expect(f.run()?.status).toBe("queued");
    expect(await engine.tick(f.admission)).toEqual({ started: true });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.run()).toMatchObject({ status: "running", provider: "codex" });
    expect(await engine.turnEnded("other", "other-turn", null)).toBe(false);
    expect(await engine.turnEnded("agent", "unrelated-turn", null)).toBe(false);
    expect(await engine.turnEnded("agent", "routine-turn", null)).toBe(true);
    expect(f.run()?.status).toBe("completed");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("发送失败时记录失败并在静默模式仍通知", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("连接失败"));
    f.routines.runNow(f.routine.id);
    await f.execution().tick(f.admission);
    await vi.waitFor(() => expect(f.run()?.status).toBe("failed"));
    expect(f.run()?.error).toBe("连接失败");
    expect(f.routines.get(f.routine.id)?.lastStatus).toBe("failed");
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("重启后保留宿主仍在运行的记录，无法确认的运行标记失败", async () => {
    const f = fixture();
    f.routines.runNow(f.routine.id);
    await f.execution().tick(f.admission);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.current.activeTurn = {};
    await f.execution().tick({ ...f.admission, paused: true });
    expect(f.run()?.status).toBe("running");
    f.current.activeTurn = null;
    await f.execution().tick({ ...f.admission, paused: true });
    expect(f.run()?.status).toBe("failed");
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("新旁线程不等待主对话空闲", async () => {
    const f = fixture();
    f.routines.update(f.routine.id, { target: "new_thread" });
    f.routines.runNow(f.routine.id);
    f.current.activeTurn = {};
    expect(await f.execution().tick(f.admission)).toEqual({ started: true });
    await vi.waitFor(() => expect(f.run()?.agent_id).toBe("thread"));
    const [thread] = f.threads.list(f.bot.id);
    expect(thread).toMatchObject({ botId: f.bot.id, title: "检查", agentId: "thread" });
    expect(f.waitThread).toHaveBeenCalledWith(f.bot.id, thread!.id);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith("检查", expect.objectContaining({ sourceAgentId: "thread" })));
  });

  it("旁线程 provider 与准入不一致时失败并通知，不发送提示词", async () => {
    const f = fixture();
    f.routines.update(f.routine.id, { target: "new_thread" });
    f.routines.runNow(f.routine.id);
    f.threadCurrent.provider = "other";
    await f.execution().tick(f.admission);
    await vi.waitFor(() => expect(f.run()?.status).toBe("failed"));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("长回合翻页找到原始消息，取消时记录失败并通知", async () => {
    const f = fixture();
    f.routines.runNow(f.routine.id);
    const engine = f.execution();
    await engine.tick(f.admission);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.refetch.mockResolvedValueOnce({ entries: [], hasOlder: true, startCursor: { epoch: "e", seq: 200 } });
    expect(await engine.turnEnded("agent", "routine-turn", "例程运行已取消")).toBe(true);
    expect(f.refetch).toHaveBeenCalledTimes(2);
    expect(f.refetch).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "before", cursor: { epoch: "e", seq: 200 } }));
    expect(f.run()).toMatchObject({ status: "failed", error: "例程运行已取消" });
    expect(f.notify).toHaveBeenCalledOnce();
  });
});

