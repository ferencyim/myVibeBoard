import { describe, expect, it, vi } from "vitest";
import { createProjectAgents } from "../server/project-agent/service";
import { registerProjectAgents } from "../server/project-agent/register";
import { UNRESOLVED_TAB_MODEL } from "../server/vibe/contract";

function fixture() {
  const agents = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      labels: Record<string, string>;
      archivedAt?: string;
      status: string;
      model?: string;
      provider?: string;
    }
  >();
  const sends = vi.fn(async () => {});
  const append = vi.fn(async () => {});
  const order: string[] = [];
  const main = {
    workspaceId: "task",
    anchorAgentId: "main",
    tabs: [{ number: 1, provider: "codex", model: "recent" }],
    phase: "planning",
    summary: "需求",
    updatedAt: "2026-10-28",
    control: { projectId: "p" },
  };
  agents.set("main", { id: "main", workspaceId: "task", labels: {}, status: "idle" });
  function handle(id: string) {
    return {
      id,
      workspaceId: agents.get(id)?.workspaceId,
      refresh: async () => {},
      current: () => agents.get(id),
      send: sends,
      timeline: { append },
    };
  }
  const createAgent = vi.fn(async (input) => {
    const id = "project-" + agents.size;
    agents.set(id, { id, workspaceId: "root", labels: input.labels, status: "idle" });
    return handle(id);
  });
  const workspaceCreate = vi.fn(async () => {
    order.push("workspace");
    return {
      id: "new",
      name: "新任务",
      agents: {
        create: async () => {
          order.push("main");
          agents.set("new-main", {
            id: "new-main",
            workspaceId: "new",
            labels: {},
            status: "idle",
          });
          return handle("new-main");
        },
      },
    };
  });
  const api = {
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/repo" }] }) },
    agents: {
      list: async () => ({
        entries: [...agents.values()].map((agent) => ({ agent })),
        pageInfo: { nextCursor: null },
      }),
      ref: handle,
      create: createAgent,
    },
    workspaces: {
      ref: (id: string) => ({
        id,
        projectId: id === "foreign" ? "other" : "p",
        refresh: async () => {},
      }),
      create: workspaceCreate,
    },
    providers: {
      listAvailable: vi.fn(async () => ({ providers: [{ provider: "codex", available: true }] })),
      snapshot: vi.fn(async (_options?: unknown) => ({
        entries: [{ provider: "codex", enabled: true, status: "ready", models: [{ id: "default-model", isDefault: true }] }],
      })),
      listModels: vi.fn(async () => ({ models: [{ id: "default-model", isDefault: true }] })),
    },
  };
  const presets = new Map<string, object>();
  const defaults: { project?: string; main?: string } = {};
  const projectConfigs: object[] = [];
  const taskRows = [main];
  const store = {
    tasks: { list: () => taskRows, markTaskWorkspace: vi.fn() },
    projects: { list: () => projectConfigs },
    modelDefaults: { global: () => defaults },
    presets: { get: (id: string) => presets.get(id) },
    prompts: { resolve: () => "角色规则" },
  };
  const tabs = {
    workspace: async () => ({ projectId: "p", name: "已有任务" }),
    ensureTab: async () => {
      order.push("ensure");
    },
  };
  const provisionTabs = vi.fn(async () => {
    order.push("roles");
  });
  const saved = new Map<string, string>();
  const db = {
    prepare: () => ({
      get: (key: string) => (saved.has(key) ? { value: saved.get(key) } : undefined),
      run: (key: string, value: string) => {
        saved.set(key, value);
      },
    }),
  };
  const build = () =>
    createProjectAgents({ db, store, getPaseo: () => api, tabs, flow: { provisionTabs } } as never);
  const service = build();
  const input = (agentId: string, text = "用户原话", messageId = "u1") => ({
    agentId,
    workspaceId: "root",
    messageId,
    text,
    images: [{ mimeType: "image/png", data: "image" }],
    attachments: [{ type: "file", name: "a" }],
  });
  return {
    service,
    agents,
    sends,
    append,
    createAgent,
    workspaceCreate,
    order,
    defaults,
    presets,
    main,
    input,
    projectConfigs,
    build,
    taskRows,
    tabs,
    providers: api.providers,
    api,
  };
}

async function openReady(service: ReturnType<typeof createProjectAgents>) {
  await service.open("p");
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await service.state("p");
    if (result.status === "failed") throw new Error(result.error ?? "创建失败");
    if (result.status === "ready") return result;
    await Promise.resolve();
  }
  throw new Error("测试中项目 agent 未完成创建");
}

describe("项目 agent", () => {
  it("创建超过插件 RPC 时限时立即返回创建中，并发 open 和状态查询不重复新建", async () => {
    const f = fixture();
    const create = f.createAgent.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.createAgent.mockImplementationOnce(async (input) => {
      await gate;
      return create(input);
    });
    const [one, two] = await Promise.all([f.service.open("p"), f.service.open("p")]);
    expect(one).toEqual({ status: "creating", agentId: null, workspaceId: null, error: null });
    expect(two).toEqual(one);
    for (let attempt = 0; attempt < 40; attempt++) await Promise.resolve();
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect((await f.service.state("p")).status).toBe("creating");
    expect((await f.service.open("p")).status).toBe("creating");
    release();
    const ready = await openReady(f.service);
    expect(ready.status).toBe("ready");
    expect(f.createAgent).toHaveBeenCalledTimes(1);
  });
  it("创建失败返回中文状态，轮询不重建，重试成功", async () => {
    const f = fixture();
    f.createAgent.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(openReady(f.service)).rejects.toThrow("创建项目 agent 失败");
    expect(await f.service.state("p")).toMatchObject({ status: "failed", agentId: null });
    expect(await f.service.state("p")).toMatchObject({ status: "failed" });
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect((await openReady(f.service)).status).toBe("ready");
    expect(f.createAgent).toHaveBeenCalledTimes(2);
    expect(f.createAgent.mock.calls[0][0]).toEqual(f.createAgent.mock.calls[1][0]);
    expect(f.createAgent.mock.calls[0][0].idempotencyKey).toMatch(/^project-agent:p:/);
  });
  it("跳过正在初始化或失败 provider，只用缓存目录且不启动慢 provider 查询", async () => {
    const f = fixture();
    f.taskRows.length = 0;
    f.providers.listAvailable.mockImplementation(() => new Promise(() => {}));
    f.providers.listModels.mockImplementation(() => new Promise(() => {}));
    f.providers.snapshot.mockResolvedValue({ entries: [
      { provider: "slow", enabled: true, status: "loading", models: [] },
      { provider: "failed", enabled: true, status: "error", models: [] },
      { provider: "disabled", enabled: false, status: "ready", models: [{ id: "unused", isDefault: true }] },
      { provider: "codex", enabled: true, status: "ready", models: [{ id: "cached", isDefault: true }] },
    ] });
    expect((await f.service.open("p")).status).toBe("creating");
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0].config.provider).toBe("codex/cached");
    expect(f.providers.listAvailable).not.toHaveBeenCalled();
    expect(f.providers.listModels).not.toHaveBeenCalled();
    expect(f.providers.snapshot).toHaveBeenCalledWith({ cachedOnly: true });
  });
  it("缓存 scope 查询超时后使用另一 scope，所有 scope 超时则失败且可重试", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.taskRows.length = 0;
      f.providers.snapshot.mockImplementationOnce(() => new Promise(() => {}));
      expect((await f.service.open("p")).status).toBe("creating");
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await f.service.state("p")).status).toBe("ready");
      expect(f.createAgent.mock.calls[0][0].config.provider).toBe("codex/default-model");
      const failed = fixture();
      failed.taskRows.length = 0;
      failed.providers.snapshot.mockImplementation(() => new Promise(() => {}));
      await failed.service.open("p");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await failed.service.state("p")).toMatchObject({ status: "failed", error: expect.stringContaining("任务默认模型") });
      failed.providers.snapshot.mockResolvedValue({ entries: [{ provider: "codex", enabled: true, status: "loading", models: [{ id: "stale", isDefault: true }] }] });
      await openReady(failed.service);
      expect(failed.createAgent.mock.calls[0][0].config.provider).toBe("codex/stale");
    } finally {
      vi.useRealTimers();
    }
  });
  it("缓存按 provider 顺序合并，优先采用该 provider 的项目目录缓存", async () => {
    const f = fixture();
    f.taskRows.length = 0;
    f.providers.snapshot.mockImplementation(async (options) => ({ entries: (options as { cwd?: string }).cwd ? [
      { provider: "first", enabled: true, status: "loading", models: [] },
      { provider: "second", enabled: true, status: "ready", models: [{ id: "scoped", isDefault: true }] },
    ] : [
      { provider: "first", enabled: true, status: "ready", models: [{ id: "global", isDefault: true }] },
      { provider: "second", enabled: true, status: "ready", models: [{ id: "other", isDefault: true }] },
    ] }));
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0].config.provider).toBe("first/global");
    const scoped = fixture();
    scoped.taskRows.length = 0;
    scoped.providers.snapshot.mockImplementation(async (options) => ({ entries: [{
      provider: "codex", enabled: true, status: "ready", models: [{ id: (options as { cwd?: string }).cwd ? "scoped" : "global", isDefault: true }],
    }] }));
    await openReady(scoped.service);
    expect(scoped.createAgent.mock.calls[0][0].config.provider).toBe("codex/scoped");
  });
  it("内部发送等待同一后台创建完成，不因入口异步化丢失系统消息", async () => {
    const f = fixture();
    const opened = await f.service.open("p");
    expect(opened.status).toBe("creating");
    await f.service.sendProject("p", "系统通知");
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.sends).toHaveBeenCalledWith("系统通知", expect.objectContaining({ sourceAgentId: expect.any(String) }));
  });
  it("状态并发单飞、项目列表共享缓存，找到 agent 后打开不再分页扫描", async () => {
    const f = fixture();
    const listProjects = vi.spyOn(f.api.projects, "list");
    const listAgents = vi.spyOn(f.api.agents, "list");
    await Promise.all(Array.from({ length: 10 }, () => f.service.state("p")));
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listAgents).toHaveBeenCalledTimes(1);
    const opened = await openReady(f.service);
    expect((await f.service.state("p")).agentId).toBe(opened.agentId);
    await openReady(f.service);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listAgents).toHaveBeenCalledTimes(1);
  });
  it("入口按需创建、并发复用，归档后重建且沿用最近 #1 模型", async () => {
    const f = fixture();
    expect((await f.service.state("p")).agentId).toBeNull();
    expect(f.createAgent).not.toHaveBeenCalled();
    const [one, two] = await Promise.all([openReady(f.service), openReady(f.service)]);
    expect(one.agentId).toBe(two.agentId);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.createAgent.mock.calls[0][0]).toMatchObject({
      cwd: "/repo",
      config: { provider: "codex/recent" },
      labels: { "vibe.role": "project", "vibe.project_id": "p" },
    });
    f.agents.get(one.agentId!)!.archivedAt = "now";
    expect((await openReady(f.service)).agentId).not.toBe(one.agentId);
    expect(f.createAgent.mock.calls[1][0].idempotencyKey).not.toBe(f.createAgent.mock.calls[0][0].idempotencyKey);
  });
  it("项目默认预设优先并保留思考、权限、指令与环境", async () => {
    const f = fixture();
    f.defaults.project = "wrong-global";
    f.projectConfigs.push({
      id: "config",
      paseoProjectId: "p",
      repoPath: "/repo",
      defaultPresets: { project: "preset" },
    });
    f.presets.set("preset", {
      models: [{ provider: "codex", model: "chosen", thinking: "high", permissionMode: "full" }],
      instructions: "补充",
      runtimeEnv: "env",
    });
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0]).toMatchObject({
      config: {
        provider: "codex/chosen",
        thinkingOptionId: "high",
        modeId: "full-access",
        systemPrompt: "角色规则\n\n补充",
      },
      env: { VIBE_RUNTIME_ENV: "env" },
    });
  });
  it("最近任务没有明确模型时使用首个可用 provider 默认模型", async () => {
    const f = fixture();
    f.main.tabs[0].model = "";
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0].config.provider).toBe("codex/default-model");
    expect(f.providers.snapshot).toHaveBeenCalledWith({ cwd: "/repo", cachedOnly: true });
    expect(f.providers.listModels).not.toHaveBeenCalled();
  });
  it("没有历史任务仍解析目录默认模型，并优先默认标记", async () => {
    const f = fixture();
    f.taskRows.length = 0;
    f.providers.snapshot.mockResolvedValue({
      entries: [{ provider: "codex", enabled: true, status: "ready", models: [
        { id: "other", isDefault: false },
        { id: "chosen", isDefault: true },
      ] }],
    });
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0].config.provider).toBe("codex/chosen");
  });
  it("最近任务尚未解析模型时仍查询目录，目录失败以中文引导设置", async () => {
    const f = fixture();
    f.main.tabs[0].model = UNRESOLVED_TAB_MODEL;
    f.providers.snapshot.mockRejectedValueOnce(new Error("catalog unavailable")).mockRejectedValueOnce(new Error("catalog unavailable"));
    await expect(openReady(f.service)).rejects.toThrow("任务默认模型");
    expect(f.createAgent).not.toHaveBeenCalled();
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0].config.provider).toBe("codex/default-model");
  });
  it("没有可用 provider 时引导设置且不创建项目 agent", async () => {
    const f = fixture();
    f.taskRows.length = 0;
    f.providers.snapshot.mockResolvedValue({ entries: [] });
    await expect(openReady(f.service)).rejects.toThrow("任务默认模型");
    expect(f.providers.listModels).not.toHaveBeenCalled();
    expect(f.createAgent).not.toHaveBeenCalled();
  });
  it("目录未标默认时采用目录首项，缺少模型则引导设置且不创建", async () => {
    const f = fixture();
    f.taskRows.length = 0;
    f.providers.snapshot.mockResolvedValue({ entries: [] });
    await expect(openReady(f.service)).rejects.toThrow("任务默认模型");
    expect(f.createAgent).not.toHaveBeenCalled();
    f.providers.snapshot.mockResolvedValue({ entries: [{ provider: "codex", enabled: true, status: "ready", models: [{ id: "first", isDefault: false }] }] });
    await openReady(f.service);
    expect(f.createAgent.mock.calls[0][0].config.provider).toBe("codex/first");
  });
  it("旧任务工作区失效不阻断项目入口和正常任务路由", async () => {
    const f = fixture();
    f.taskRows.push({ ...f.main, workspaceId: "missing", control: {} } as never);
    const normal = f.tabs.workspace;
    f.tabs.workspace = async (id?: string) => {
      if (id === "missing") throw new Error("workspace missing");
      return normal();
    };
    const id = (await openReady(f.service)).agentId!;
    expect((await f.service.tasksFor(id)).plans).toHaveLength(1);
    await f.service.received(f.input(id) as never);
    await f.service.route(id, { workspaceId: "task", text: "用户原话" });
    expect(f.sends).toHaveBeenCalledTimes(1);
  });
  it("拒绝任务 tab 与跨项目伪标签调用", async () => {
    const f = fixture();
    await expect(f.service.tasksFor("main")).rejects.toThrow("仅供项目 agent");
    f.agents.set("fake", {
      id: "fake",
      workspaceId: "foreign",
      labels: { "vibe.role": "project", "vibe.project_id": "p" },
      status: "idle",
    });
    await expect(f.service.tasksFor("fake")).rejects.toThrow("仅供项目 agent");
  });
  it("只有原生成功投递事件授予原话权限，附带附件且只消费一次", async () => {
    const f = fixture();
    const opened = await openReady(f.service);
    const id = opened.agentId!;
    await expect(f.service.route(id, { workspaceId: "task", text: "用户原话" })).rejects.toThrow(
      "真实用户",
    );
    await f.service.received(f.input(id) as never);
    await expect(f.service.route(id, { workspaceId: "task", text: "改写" })).rejects.toThrow(
      "真实用户",
    );
    await expect(f.service.route(id, { workspaceId: "other", text: "用户原话" })).rejects.toThrow(
      "本项目",
    );
    await f.service.route(id, { workspaceId: "task", text: "用户原话" });
    expect(f.sends).toHaveBeenCalledWith(
      "用户原话",
      expect.objectContaining({
        messageId: "project-route:u1",
        images: [{ mimeType: "image/png", data: "image" }],
        attachments: [{ type: "file", name: "a" }],
      }),
    );
    expect(f.sends.mock.calls[0][1]).not.toHaveProperty("sourceAgentId");
    expect(f.append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-route",
        data: { text: "已转给 已有任务 #1", workspaceId: "task", agentId: "main" },
      }),
    );
    await expect(f.service.route(id, { workspaceId: "task", text: "用户原话" })).rejects.toThrow(
      "真实用户",
    );
  });
  it("澄清答复与系统通知不冒充用户，重启后仍路由原始需求", async () => {
    const f = fixture();
    const id = (await openReady(f.service)).agentId!;
    await f.service.received(f.input(id) as never);
    await f.service.received(f.input(id, "续接已有任务", "u2") as never);
    await f.service.sendProject("p", "系统通知");
    const resumed = f.build();
    await expect(resumed.route(id, { workspaceId: "task", text: "系统通知" })).rejects.toThrow(
      "真实用户",
    );
    await resumed.route(id, { workspaceId: "task", text: "用户原话", sourceMessageId: "u1" });
    expect(f.sends).toHaveBeenLastCalledWith(
      "用户原话",
      expect.objectContaining({ images: [{ mimeType: "image/png", data: "image" }] }),
    );
    await expect(
      f.build().route(id, { workspaceId: "task", text: "用户原话", sourceMessageId: "u1" }),
    ).rejects.toThrow("真实用户");
  });
  it("同一输入并发 route 与 create 只准一个操作，验证失败释放临界区", async () => {
    const f = fixture();
    const id = (await openReady(f.service)).agentId!;
    await f.service.received(f.input(id) as never);
    const outcomes = await Promise.allSettled([
      f.service.route(id, { workspaceId: "task", text: "用户原话" }),
      f.service.create(id, { text: "用户原话" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.workspaceCreate).not.toHaveBeenCalled();
    await f.service.received(f.input(id, "第二条", "u2") as never);
    await expect(f.service.route(id, { workspaceId: "invalid", text: "第二条" })).rejects.toThrow(
      "本项目",
    );
    await f.service.route(id, { workspaceId: "task", text: "第二条" });
  });
  it("同文需求需明确来源，超过缓存上限显示重发原因", async () => {
    const f = fixture();
    const id = (await openReady(f.service)).agentId!;
    await f.service.received(f.input(id) as never);
    await f.service.received(f.input(id, "用户原话", "u2") as never);
    await expect(f.service.route(id, { workspaceId: "task", text: "用户原话" })).rejects.toThrow(
      "sourceMessageId",
    );
    for (let n = 3; n <= 21; n++)
      await f.service.received(f.input(id, "需求" + n, "u" + n) as never);
    expect(f.append).toHaveBeenCalledWith(
      expect.objectContaining({ data: { text: expect.stringContaining("最早未路由需求") } }),
    );
    const large = f.input(id, "超大", "large");
    large.images[0].data = "x".repeat(8 * 1024 * 1024);
    await f.service.received(large as never);
    expect(f.append).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { text: expect.stringContaining("超过 8 MiB") } }),
    );
    await expect(f.service.route(id, { workspaceId: "task", text: "超大" })).rejects.toThrow(
      "真实用户",
    );
  });
  it("任务创建先预建流程角色再投递，重试复用工作区与主会话", async () => {
    const f = fixture();
    const id = (await openReady(f.service)).agentId!;
    await f.service.received(f.input(id) as never);
    f.sends.mockRejectedValueOnce(new Error("超时"));
    await expect(f.service.create(id, { text: "用户原话" })).rejects.toThrow("超时");
    await f.build().create(id, { text: "用户原话" });
    expect(f.workspaceCreate).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["workspace", "main", "ensure", "roles", "ensure", "roles"]);
    expect(f.workspaceCreate.mock.calls[0][0]).toMatchObject({
      idempotencyKey: "project-task:u1",
      source: { kind: "worktree", projectId: "p" },
    });
    expect(f.sends.mock.calls[0][1].messageId).toBe(f.sends.mock.calls[1][1].messageId);
  });
  it("注册层只监听真实用户成功投递，不使用接管或agent消息授权", () => {
    const f = fixture();
    const events: string[] = [];
    const server = {
      handle: vi.fn(),
      registerAgentTool: vi.fn(),
      on: (name: string) => {
        events.push(name);
        return () => {};
      },
    };
    registerProjectAgents(server as never, f.service);
    expect(events).toEqual(["agent.user_prompt_received"]);
  });
});
