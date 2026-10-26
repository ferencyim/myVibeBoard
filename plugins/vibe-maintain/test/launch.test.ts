import { describe, expect, it } from "vitest";
import { createMaintenanceTaskLauncher } from "../server/launch";
import { createTaskRuntimeCommands } from "../server/vibe/db";
import type { MaintenanceRule, Preset } from "../server/vibe/contract";
import { setup, tempDir } from "./helpers";

function harness(
  options: { autoBind?: boolean; denied?: boolean; nonGit?: boolean; sendFails?: boolean } = {},
) {
  const h = setup({ repo: tempDir() });
  const sent: Array<{ prompt: string; sourceAgentId: string }> = [];
  const created: Array<{ agentId: string; prompt?: string; config?: unknown; labels?: unknown }> =
    [];
  const resources: Array<Record<string, unknown>> = [];
  const sources: unknown[] = [];
  const createdLinks: string[] = [];
  const paseo = {
    projects: {
      list: async () => ({
        projects: [
          {
            projectId: "native-project",
            projectRootPath: h.project.repoPath,
            projectKind: options.nonGit ? "directory" : "git",
          },
        ],
      }),
    },
    agents: {
      ref: () => ({
        archive: async () => {},
        send: async (prompt: string, value: { sourceAgentId: string }) =>
          sent.push({ prompt, ...value }),
      }),
    },
    workspaces: {
      create: async (config: unknown) => {
        sources.push(config);
        return {
          id: "workspace-1",
          directory: "D:/devRepoCaches/worktrees/fixture",
          agents: {
            create: async (input: {
              agentId: string;
              prompt?: string;
              config?: unknown;
              labels?: unknown;
            }) => {
              created.push(input);
              if (options.autoBind)
                h.store.tasks.create({ workspaceId: "workspace-1", anchorAgentId: input.agentId });
              return {
                send: async (prompt: string, value: { sourceAgentId: string }) => {
                  if (options.sendFails) throw new Error("发送失败");
                  sent.push({ prompt, ...value });
                },
              };
            },
          },
        };
      },
    },
  };
  const preset = {
    id: "maintenance",
    name: "维护",
    provider: "codex",
    model: "test",
    permissionMode: "full",
    thinking: "high",
    models: [{ provider: "codex", model: "test", permissionMode: "full", thinking: "high" }],
  } as Preset;
  const runtime = createTaskRuntimeCommands(h.db);
  const launcher = createMaintenanceTaskLauncher({
    getPaseo: () => paseo as never,
    store: h.store,
    runtime,
    presets: () => [preset],
    defaultAgent: () => "codex/test",
    resource: async (input) => {
      resources.push(input);
      return {
        ok: !options.denied,
        reason: options.denied ? "并发已满" : "已准入",
        reservationId: "reservation-1",
      };
    },
  });
  const input = {
    rule: { id: "rule", name: "体检", agent: "maintenance" } as MaintenanceRule,
    project: h.project,
    prompt: "只读生成维护方案，等待用户 /执行",
    onCreated: ({ workspaceId }: { workspaceId: string }) => {
      createdLinks.push(workspaceId);
    },
  };
  return { h, runtime, launcher, input, sent, created, sources, resources, createdLinks };
}

describe("维护原生规划启动器", () => {
  it("新建独立worktree，按默认模式规划，资源准入与绑定后才发首消息", async () => {
    const s = harness();
    const result = await s.launcher.launch(s.input);
    expect(s.sources[0]).toMatchObject({
      source: { kind: "worktree", action: "branch-off", projectId: "native-project" },
    });
    expect(s.created[0]).toMatchObject({
      config: { provider: "codex/test" },
      labels: { role: "planner" },
    });
    expect(s.created[0]!.prompt).toBeUndefined();
    const config = s.created[0]!.config as { modeId?: string; options?: unknown };
    expect(config.modeId).toBeUndefined();
    expect(config.options).toBeUndefined();
    expect(s.resources.map((r) => r.action)).toEqual(["acquire", "bind"]);
    expect(s.sent[0]!.sourceAgentId).toBe(result.anchorAgentId);
    expect(s.sent[0]!.prompt).toContain("vibe-plan");
    expect(s.h.store.tasks.get(result.workspaceId)).toMatchObject({
      phase: "planning",
      confirmedAt: null,
    });
    expect(s.runtime.findSessionByAgent(result.anchorAgentId)).toMatchObject({
      workspaceId: result.workspaceId,
      projectId: s.h.project.id,
      role: "planner",
      model: "test",
    });
    await s.launcher.release(result.anchorAgentId);
    expect(s.resources.at(-1)?.action).toBe("release");
  });
  it("复用WP111已绑定的同一anchor", async () => {
    const s = harness({ autoBind: true });
    await s.launcher.launch(s.input);
    expect(s.h.store.tasks.list()).toHaveLength(1);
    expect(s.createdLinks).toEqual(["workspace-1"]);
  });
  it("调度拒绝保留task和发现关联，不发送首消息", async () => {
    const s = harness({ denied: true });
    await expect(s.launcher.launch(s.input)).rejects.toThrow("资源未准入");
    expect(s.sent).toEqual([]);
    expect(s.h.store.tasks.get("workspace-1")?.confirmedAt).toBeNull();
    expect(s.createdLinks).toEqual(["workspace-1"]);
  });
  it("资源暂满先保留规划排队，资源可用后发送一次", async () => {
    const s = harness();
    let acquired = 0;
    const queued = createMaintenanceTaskLauncher({
      getPaseo: () =>
        ({
          projects: {
            list: async () => ({
              projects: [
                { projectId: "p", projectRootPath: s.h.project.repoPath, projectKind: "git" },
              ],
            }),
          },
          workspaces: {
            create: async () => ({
              id: "queued-workspace",
              agents: {
                create: async () => ({
                  send: async () => {
                    s.sent.push({ prompt: "规划", sourceAgentId: "anchor" });
                  },
                }),
              },
            }),
          },
          agents: { ref: () => ({ archive: async () => {} }) },
        }) as never,
      store: s.h.store,
      runtime: s.runtime,
      presets: () => [],
      defaultAgent: () => "codex/test",
      resource: async (input) => {
        if (input.action === "acquire" && acquired++ === 0)
          return { ok: false, retryable: true, reason: "并发已满" };
        return { ok: true, reason: "已准入", reservationId: "r" };
      },
    });
    await queued.launch({ ...s.input, rule: { ...s.input.rule, agent: "codex/test" } });
    expect(acquired).toBe(2);
    expect(s.sent).toHaveLength(1);
    expect(s.h.store.tasks.get("queued-workspace")?.confirmedAt).toBeNull();
  });

  it("非Git项目不能在原目录执行维护", async () => {
    const s = harness({ nonGit: true });
    await expect(s.launcher.launch(s.input)).rejects.toThrow("无法创建独立 worktree");
    expect(s.sources).toEqual([]);
    expect(s.sent).toEqual([]);
  });
  it("首消息发送失败仍保留task关联，禁止新建另一个anchor兜底", async () => {
    const s = harness({ sendFails: true });
    await expect(s.launcher.launch(s.input)).rejects.toThrow("发送失败");
    expect(s.created).toHaveLength(1);
    expect(s.createdLinks).toEqual(["workspace-1"]);
    expect(s.h.store.tasks.get("workspace-1")?.summary).toContain("发送失败");
  });
  it("补充发现也重新申请规划资源", async () => {
    const s = harness();
    const task = await s.launcher.launch(s.input);
    await s.launcher.release(task.anchorAgentId);
    await s.launcher.append({ ...task, prompt: "新增发现，重做方案" });
    expect(s.resources.map((r) => r.action)).toEqual([
      "acquire",
      "bind",
      "release",
      "acquire",
      "bind",
    ]);
    expect(s.sent).toHaveLength(2);
  });
});
