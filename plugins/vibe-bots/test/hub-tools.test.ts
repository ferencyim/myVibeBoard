import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { BotService } from "../server/service";
import type { BotMessaging } from "../server/messages";
import { registerHubTools } from "../server/hub-tools";
import { armHubTurnWatchdog } from "../server/hub-turn-watchdog";

vi.mock("../server/hub-turn-watchdog", () => ({ armHubTurnWatchdog: vi.fn() }));

describe("vibe_hub_status", () => {
  function fixture(result: unknown, takeover: unknown = { enabled: false, active: false, available: true, disabledFile: false }) {
    const handlers = new Map<string, (value: unknown, ctx: { callerAgentId: string }) => Promise<unknown>>();
    const invoke = vi.fn(async (_plugin: string, method: string) => method === "hub.takeover.get"
      ? takeover
      : result);
    const notify = vi.fn();
    const server = {
      paseo: { plugins: { invoke }, agents: { ref: () => ({}) } },
      notify,
      registerAgentTool: (tool: { name: string; handler: (value: unknown, ctx: { callerAgentId: string }) => Promise<unknown> }) => handlers.set(tool.name, tool.handler),
    } as unknown as PluginServerContext;
    const service = { caller: async () => ({ role: "coordinator", mainAgentId: "agent-1" }) } as unknown as BotService;
    registerHubTools(server, service, {} as BotMessaging);
    return { invoke, notify, call: () => handlers.get("vibe_hub_status")!({}, { callerAgentId: "agent-1" }) };
  }

  it("preserves the full status returned by the scheduler", async () => {
    const status = { machine: { handles: 42, blockedBy: [] }, queue: [], resources: [], pauses: [{ id: "p" }] };
    const { call, invoke } = fixture(status);
    await expect(call()).resolves.toEqual({ ...status, takeover: { enabled: false, active: false, available: true, disabledFile: false } });
    expect(invoke).toHaveBeenCalledWith("vibe-scheduler", "hub.status", {});
    expect(invoke).toHaveBeenCalledWith("vibe-scheduler", "hub.takeover.get", {});
  });

  it("reports an empty or malformed status as an error", async () => {
    await expect(fixture({}).call()).rejects.toThrow("中枢返回了无效状态");
    await expect(fixture({ machine: {}, queue: null, resources: [] }).call()).rejects.toThrow("中枢返回了无效状态");
  });

  it("marks malformed takeover data as unavailable", async () => {
    const status = { machine: { handles: null, blockedBy: [] }, queue: [], resources: [] };
    await expect(fixture(status, {}).call()).resolves.toEqual({
      ...status,
      takeover: { error: "中枢返回了无效的接管状态" },
    });
  });

  it("notifies the user when the status turn stalls", async () => {
    const { call, notify } = fixture({ machine: { handles: null, blockedBy: [] }, queue: [], resources: [] });
    await call();
    const onTimeout = vi.mocked(armHubTurnWatchdog).mock.lastCall?.[1];
    expect(onTimeout).toBeTypeOf("function");
    onTimeout!();
    expect(notify).toHaveBeenCalledWith({
      title: "总协调 bot",
      body: "中枢状态调用后 15 分钟没有进展，已请求取消该轮，请打开对话检查。",
      data: { agentId: "agent-1" },
    });
  });
});
