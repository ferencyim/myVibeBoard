import { expect, test, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerProjectConfigTool } from "./config";

type Tool = Parameters<PluginServerContext["registerAgentTool"]>[0];
function setup() {
  let tool: Tool | undefined;
  const readConfig = vi.fn(async () => ({ ok: true, config: null, revision: null }));
  const writeConfig = vi.fn(async () => ({ ok: false, error: { code: "stale_project_config" } }));
  const callerProject = vi.fn(async (id: string | undefined) => {
    if (id !== "project-agent") throw new Error("仅项目 agent 可用");
    return "project-a";
  });
  const project = vi.fn(async () => ({ projectRootPath: "/repo/a" }));
  registerProjectConfigTool(
    {
      paseo: { projects: { readConfig, writeConfig } },
      registerAgentTool(value: Tool) {
        tool = value;
      },
    } as PluginServerContext,
    { callerProject, project } as Parameters<typeof registerProjectConfigTool>[1],
  );
  return {
    readConfig,
    writeConfig,
    callerProject,
    project,
    call: (input: unknown, callerAgentId: string | undefined = "project-agent") =>
      tool!.handler(input, {
        callerAgentId,
      } as Parameters<Tool["handler"]>[1]),
  };
}

test("项目配置工具拒绝任务 tab 和无会话调用", async () => {
  const fixture = setup();
  await expect(fixture.call({ action: "read" }, "task-tab")).rejects.toThrow("仅项目 agent");
  await expect(fixture.call({ action: "read" }, "")).rejects.toThrow("仅项目 agent");
  expect(fixture.project).not.toHaveBeenCalled();
  expect(fixture.readConfig).not.toHaveBeenCalled();
});

test("读取只使用角色绑定项目根，拒绝调用者传跨项目路径", async () => {
  const fixture = setup();
  await expect(fixture.call({ action: "read" })).resolves.toMatchObject({ ok: true });
  expect(fixture.project).toHaveBeenCalledWith("project-a");
  expect(fixture.readConfig).toHaveBeenCalledWith("/repo/a");
  await expect(fixture.call({ action: "read", repoRoot: "/repo/b" })).rejects.toThrow();
  expect(fixture.readConfig).toHaveBeenCalledTimes(1);
});

test("写入保留完整配置与修订号并返回并发冲突", async () => {
  const fixture = setup();
  const config = {
    worktree: { setup: ["npm ci"] },
    scripts: { dev: { command: "npm run dev" } },
    custom: true,
  };
  const expectedRevision = { mtimeMs: 10, size: 42 };
  await expect(fixture.call({ action: "write", config, expectedRevision })).resolves.toMatchObject({
    ok: false,
    error: { code: "stale_project_config" },
  });
  expect(fixture.writeConfig).toHaveBeenCalledWith({
    repoRoot: "/repo/a",
    config,
    expectedRevision,
  });
  await expect(fixture.call({ action: "write", config })).rejects.toThrow();
  expect(fixture.writeConfig).toHaveBeenCalledTimes(1);
});
