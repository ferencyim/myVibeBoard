import { expect, it, vi } from "vitest";
import { registerProjectBotRpcs } from "./bots";

it("合并同一项目的并发列表请求，失败后允许重新请求", async () => {
  let reject!: (error: Error) => void;
  const invoke = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValue({ bots: [] });
  const handlers = new Map<string, (input: { projectId: string }, context: object) => Promise<unknown>>();
  registerProjectBotRpcs({
    handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler),
  } as never);
  const list = handlers.get("bots.list")!;
  const context = { paseo: { plugins: { invoke } } };
  const first = list({ projectId: "p" }, context);
  const second = list({ projectId: "p" }, context);
  const other = list({ projectId: "other" }, context);
  expect(invoke).toHaveBeenCalledTimes(2);
  reject(new Error("暂不可用"));
  await expect(first).rejects.toThrow("暂不可用");
  await expect(second).rejects.toThrow("暂不可用");
  await expect(other).resolves.toEqual({ bots: [] });
  await expect(list({ projectId: "p" }, context)).resolves.toEqual({ bots: [] });
  expect(invoke).toHaveBeenCalledTimes(3);
});
