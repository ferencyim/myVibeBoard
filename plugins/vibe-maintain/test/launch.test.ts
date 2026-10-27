import { describe, expect, it } from "vitest";
import { createMaintenanceTaskLauncher } from "../server/launch";
import { createTaskRuntimeCommands } from "../server/vibe/db";
import type { MaintenanceRule, Preset } from "../server/vibe/contract";
import { setup, tempDir } from "./helpers";

function harness(
  options: {
    board?: boolean;
    denied?: boolean;
    nonGit?: boolean;
    sendFails?: boolean;
    unavailableFirst?: boolean;
    allUnavailable?: boolean;
  } = {},
) {
  const h = setup({ repo: tempDir() });
  const sent: Array<{ prompt: string; sourceAgentId: string; agentId?: string }> = [];
  const created: Array<{ agentId: string; prompt?: string; config?: unknown; labels?: unknown }> =
    [];
  const resources: Array<Record<string, unknown>> = [];
  const sources: unknown[] = [];
  const createdLinks: string[] = [];
  const archivedWorkspaces: string[] = [];
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
      ref: (agentId: string) => ({
        archive: async () => {},
        send: async (prompt: string, value: { sourceAgentId: string }) => {
          if (options.sendFails) throw new Error("发送失败");
          sent.push({ prompt, ...value, agentId });
        },
      }),
    },
    workspaces: {
      archive: async (workspaceId: string) => {
        archivedWorkspaces.push(workspaceId);
        return {};
      },
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
              if (options.allUnavailable || (options.unavailableFirst && created.length === 1))
                throw new Error("model not found: test");
              // What vibe-board does on agent.created for a marked task workspace: #1 主会话 for
              // the anchor, then the pre-created role tabs starting with #2 方案.
              if (options.board) {
                expect(h.store.tasks.isTaskWorkspace("workspace-1")).toBe(true);
                const task = h.store.tasks.get("workspace-1")!;
                expect(task.anchorAgentId).toBe(input.agentId);
                for (const [agentId, role, model] of [
                  [input.agentId, "main", "test"],
                  ["planner-agent", "planner", "planner-model"],
                  ["worker-agent", "worker", "test"],
                ] as const)
                  h.store.tasks.allocateTab("workspace-1", { agentId, role, provider: "codex", model });
              }
              return { id: input.agentId };
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
  const deps: Parameters<typeof createMaintenanceTaskLauncher>[0] = {
    getPaseo: () => paseo as never,
    store: h.store,
    runtime,
    plannerTabWaitMs: 0,
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
  };
  const launcher = createMaintenanceTaskLauncher(deps);
  const input = {
    rule: { id: "rule", name: "体检", agent: "maintenance" } as MaintenanceRule,
    project: h.project,
    prompt: "只读生成维护方案，等待用户 /执行",
    onCreated: ({ workspaceId }: { workspaceId: string }) => {
      createdLinks.push(workspaceId);
    },
  };
  return {
    h,
    runtime,
    launcher,
    deps,
    preset,
    input,
    sent,
    created,
    sources,
    resources,
    createdLinks,
    archivedWorkspaces,
  };
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
      labels: { role: "main" },
      env: { VIBE_ROLE: "main" },
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
      anchorAgentId: result.anchorAgentId,
      roleSelections: { planner: { mode: "preset", presetId: "maintenance" } },
    });
    expect(s.h.store.tasks.isTaskWorkspace(result.workspaceId)).toBe(true);
    expect(s.runtime.findSessionByAgent(result.anchorAgentId)).toMatchObject({
      workspaceId: result.workspaceId,
      projectId: s.h.project.id,
      role: "planner",
      model: "test",
    });
    await s.launcher.release(result.anchorAgentId);
    expect(s.resources.at(-1)?.action).toBe("release");
  });
  it("WP-130：任务先于首个 agent 建好，vibe-board 立即建齐 tab；维护提示词由 #1 交给 #2 方案", async () => {
    const s = harness({ board: true });
    const launcher = createMaintenanceTaskLauncher({
      ...s.deps,
      plannerTabWaitMs: 2_000,
    });
    const result = await launcher.launch(s.input);
    expect(s.h.store.tasks.list()).toHaveLength(1);
    expect(s.createdLinks).toEqual(["workspace-1"]);
    const task = s.h.store.tasks.get(result.workspaceId)!;
    expect(task.tabs.map((tab) => [tab.number, tab.role])).toEqual([
      [1, "main"],
      [2, "planner"],
      [3, "worker"],
    ]);
    expect(s.created).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ agentId: "planner-agent", sourceAgentId: result.anchorAgentId });
    expect(s.sent[0]!.prompt).toContain("vibe-plan");
    expect(s.resources.find((r) => r.action === "acquire")).toMatchObject({
      role: "planner",
      model: "planner-model",
    });
    expect(s.resources.find((r) => r.action === "bind")).toMatchObject({ agentId: "planner-agent" });
    expect(s.runtime.findSessionByAgent("planner-agent")).toMatchObject({ role: "planner" });
    await launcher.append({ ...result, prompt: "新增发现" });
    expect(s.sent.at(-1)).toMatchObject({ agentId: "planner-agent" });
  });
  it("首个 anchor 模型不可用时换下一个候选，并替换任务的初始 anchor", async () => {
    const s = harness({ unavailableFirst: true });
    s.deps.presets = () => [
      {
        ...s.preset,
        models: [
          { provider: "codex", model: "gone", permissionMode: "full", thinking: "high" },
          { provider: "codex", model: "test", permissionMode: "full", thinking: "high" },
        ],
      } as Preset,
    ];
    const launcher = createMaintenanceTaskLauncher(s.deps);
    const result = await launcher.launch(s.input);
    expect(s.created).toHaveLength(2);
    expect(result.anchorAgentId).toBe(s.created[1]!.agentId);
    expect(s.h.store.tasks.get(result.workspaceId)?.anchorAgentId).toBe(result.anchorAgentId);
  });
  it("所有候选模型都不可用：回滚任务行并归档 workspace，不留幽灵任务", async () => {
    const s = harness({ allUnavailable: true });
    s.deps.presets = () => [
      {
        ...s.preset,
        models: [
          { provider: "codex", model: "gone", permissionMode: "full", thinking: "high" },
          { provider: "codex", model: "test", permissionMode: "full", thinking: "high" },
        ],
      } as Preset,
    ];
    const launcher = createMaintenanceTaskLauncher(s.deps);
    await expect(launcher.launch(s.input)).rejects.toThrow("model not found");
    expect(s.created).toHaveLength(2);
    expect(s.h.store.tasks.get("workspace-1")).toBeUndefined();
    expect(s.h.store.tasks.list()).toEqual([]);
    expect(s.h.store.tasks.isTaskWorkspace("workspace-1")).toBe(false);
    expect(s.archivedWorkspaces).toEqual(["workspace-1"]);
    expect(s.createdLinks).toEqual([]);
    expect(s.sent).toEqual([]);
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
              agents: { create: async () => ({}) },
            }),
          },
          agents: {
            ref: () => ({
              archive: async () => {},
              send: async () => {
                s.sent.push({ prompt: "规划", sourceAgentId: "anchor" });
              },
            }),
          },
        }) as never,
      store: s.h.store,
      runtime: s.runtime,
      plannerTabWaitMs: 0,
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
