import { expect, it, vi } from "vitest";
import { registerProjectBotRpcs } from "../server/project-agent/bots";

function fixture() {
  const invoke = vi.fn(async () => ({ ok: true }));
  type Handler = (input: unknown, context: object) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  registerProjectBotRpcs({
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
  } as never);
  return {
    invoke,
    call(method: string, input: unknown, callerAgentId: string | null) {
      return handlers.get(method)!(input, { callerAgentId, paseo: { plugins: { invoke } } });
    },
  };
}

it.each([
  ["bots.list", { projectId: "other-project" }],
  ["bots.create", { kind: "project", projectId: "other-project", name: "越权 bot" }],
  ["bots.open", { id: "bot_other" }],
  ["bots.archive", { id: "bot_other" }],
])("项目 bot RPC 代理 %s 拒绝 agent 调用并且不转发", async (method, input) => {
  const f = fixture();
  await expect(f.call(method, input, "project-bot-agent")).rejects.toThrow("仅供用户使用");
  expect(f.invoke).not.toHaveBeenCalled();
});

it("项目 bot 代理拒绝由项目入口创建独立 bot", async () => {
  const f = fixture();
  await expect(f.call("bots.create", { kind: "independent", name: "bot" }, null)).rejects.toThrow("只能新建项目 bot");
  expect(f.invoke).not.toHaveBeenCalled();
});

it("用户归档请求转发给 bot 服务", async () => {
  const f = fixture();
  await expect(f.call("bots.archive", { id: "bot_project" }, null)).resolves.toEqual({ ok: true });
  expect(f.invoke).toHaveBeenCalledWith("vibe-bots", "bots.archive", { id: "bot_project" });
});
