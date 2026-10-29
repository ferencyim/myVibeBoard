import { describe, expect, it, vi } from "vitest";
import type { PluginAgentTool, PluginServerContext } from "@getpaseo/plugin/server";
import { registerRoutineTools } from "../server/routine-tools";
import type { BotService } from "../server/service";
import type { createRoutineStore } from "../server/vibe/db/routines";

describe("例程工具权限", () => {
  it("仅列出和操作调用 bot 自己的例程", async () => {
    const tools = new Map<string, PluginAgentTool>();
    const server = { registerAgentTool: (tool: PluginAgentTool) => tools.set(tool.name, tool) } as unknown as PluginServerContext;
    const service = { caller: vi.fn(async (id: string | null) => {
      if (id !== "agent-a") throw new Error("调用者不是 bot");
      return { id: "bot-a" };
    }) } as unknown as BotService;
    const store = {
      list: vi.fn(() => []),
      get: vi.fn((id: string) => id === "own" ? { botId: "bot-a" } : { botId: "bot-b" }),
      pause: vi.fn(), resume: vi.fn(), delete: vi.fn(), runNow: vi.fn(), update: vi.fn(), create: vi.fn(),
    };
    registerRoutineTools(server, service, store as unknown as ReturnType<typeof createRoutineStore>);
    const call = (name: string, input: unknown, callerAgentId: string | null = "agent-a") =>
      tools.get(`vibe_routine_${name}`)!.handler(input, { callerAgentId });
    await call("create", { botId: "bot-b", title: "例程", schedule: { kind: "interval", minutes: 10 }, timezone: "UTC", prompt: "执行" });
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-a" }));
    await call("list", {});
    expect(store.list).toHaveBeenCalledWith("bot-a");
    for (const name of ["pause", "resume", "delete", "run_now"]) {
      await expect(call(name, { id: "other" })).rejects.toThrow("不属于");
      await call(name, { id: "own" });
    }
    await expect(call("update", { id: "other", patch: {} })).rejects.toThrow("不属于");
    await expect(call("list", {}, null)).rejects.toThrow("不是 bot");
    expect(store.pause).toHaveBeenCalledOnce();
    expect(store.resume).toHaveBeenCalledOnce();
    expect(store.delete).toHaveBeenCalledOnce();
    expect(store.runNow).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
  });
});

