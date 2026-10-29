import { describe, expect, it, vi } from "vitest";
import { createProjectAgents } from "../server/project-agent/service";
import { registerProjectAgents } from "../server/project-agent/register";

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
  let defaultBotId = "bot_default";
  const botAgents = new Map<string, string>();
  const invoke = vi.fn(async (_pluginId: string, method: string, input: { projectId?: string; id?: string }) => {
    if (method === "bots.list") return { bots: [...agents.values()].filter((agent) => agent.labels["vibe.bot"] === "bot_independent").map((agent) => ({ mainAgentId: agent.id })) };
    if (method === "project.default_bot.get")
      return { botId: defaultBotId, mainAgentId: botAgents.get(defaultBotId) ?? null };
    if (method === "bots.open") {
      const id = input.id!;
      const previous = botAgents.get(id);
      if (previous && !agents.get(previous)?.archivedAt)
        return { agentId: previous, workspaceId: "root" };
      const opened = await createAgent({ labels: {
        "vibe.bot": id, "vibe.bot-thread": "main", "vibe.role": "project", "vibe.project_id": "p",
      } });
      botAgents.set(id, opened.id);
      return { agentId: opened.id, workspaceId: "root" };
    }
    throw new Error("unexpected RPC: " + method);
  });
  const api = {
    plugins: { invoke },
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
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }),
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
    invoke,
    setDefaultBot: (id: string) => { defaultBotId = id; },
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

describe("项目 agent", () => {
  it("项目入口委托默认 bot 服务懒创建、并发复用，状态不创建会话", async () => {
    const f = fixture();
    expect((await f.service.state("p")).agentId).toBeNull();
    expect(f.createAgent).not.toHaveBeenCalled();
    const [one, two] = await Promise.all([f.service.open("p"), f.service.open("p")]);
    expect(one.agentId).toBe(two.agentId);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledWith("vibe-bots", "bots.open", { id: "bot_default" });
    expect((await f.service.state("p")).agentId).toBe(one.agentId);
  });
  it("默认 bot 改变后入口与系统通知使用新默认，原 bot 仍可处理自己的需求", async () => {
    const f = fixture();
    const first = (await f.service.open("p")).agentId!;
    await f.service.received(f.input(first) as never);
    f.setDefaultBot("bot_other");
    const second = (await f.service.open("p")).agentId!;
    expect(second).not.toBe(first);
    expect((await f.service.state("p")).agentId).toBe(second);
    await f.service.sendProject("p", "环境通知");
    expect(f.sends).toHaveBeenLastCalledWith("环境通知", { sourceAgentId: second });
    await f.service.route(first, { workspaceId: "task", text: "用户原话" });
    expect(f.sends).toHaveBeenLastCalledWith("用户原话", expect.objectContaining({ messageId: "project-route:u1" }));
  });
  it("bot 服务失败显示错误并允许重试，不私自创建未登记的项目 agent", async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(new Error("bot 服务暂不可用"));
    await expect(f.service.open("p")).rejects.toThrow("bot 服务暂不可用");
    expect(f.createAgent).not.toHaveBeenCalled();
    expect((await f.service.state("p")).error).toBe("bot 服务暂不可用");
    expect((await f.service.open("p")).error).toBeNull();
  });
  it("项目 bot 模型解析保留项目预设、权限、指令与运行环境", async () => {
    const f = fixture();
    f.defaults.project = "wrong-global";
    f.projectConfigs.push({ id: "config", paseoProjectId: "p", repoPath: "/repo", defaultPresets: { project: "preset" } });
    f.presets.set("preset", { models: [{ provider: "codex", model: "chosen", thinking: "high", permissionMode: "full" }], instructions: "补充", runtimeEnv: "env" });
    expect(await f.service.resolveModel("p")).toEqual({
      config: { provider: "codex/chosen", thinkingOptionId: "high", modeId: "full-access", systemPrompt: "补充" },
      runtimeEnv: "env",
    });
    expect(f.createAgent).not.toHaveBeenCalled();
  });
  it("无预设时沿用最近任务 #1 明确模型，无任务时取 provider 目录默认", async () => {
    const f = fixture();
    expect((await f.service.resolveModel("p")).config.provider).toBe("codex/recent");
    f.taskRows.length = 0;
    expect((await f.service.resolveModel("p")).config.provider).toBe("codex/default-model");
    expect(f.providers.listModels).toHaveBeenCalledWith("codex", { cwd: "/repo" });
  });
  it("目录不可用或无模型时不创建会话，中文错误引导用户选择具体模型", async () => {
    const f = fixture();
    f.taskRows.length = 0;
    f.providers.listModels.mockRejectedValueOnce(new Error("目录离线"));
    await expect(f.service.resolveModel("p")).rejects.toThrow("任务默认模型");
    f.providers.listModels.mockResolvedValue({ models: [] });
    await expect(f.service.resolveModel("p")).rejects.toThrow("任务默认模型");
    expect(f.createAgent).not.toHaveBeenCalled();
  });
  it("旧任务工作区失效不阻断项目入口和正常任务路由", async () => {
    const f = fixture();
    f.taskRows.push({ ...f.main, workspaceId: "missing", control: {} } as never);
    const normal = f.tabs.workspace;
    f.tabs.workspace = async (id?: string) => {
      if (id === "missing") throw new Error("workspace missing");
      return normal();
    };
    const id = (await f.service.open("p")).agentId!;
    expect((await f.service.tasksFor(id)).plans).toHaveLength(1);
    await f.service.received(f.input(id) as never);
    await f.service.route(id, { workspaceId: "task", text: "用户原话" });
    expect(f.sends).toHaveBeenCalledTimes(1);
  });
  it("拒绝任务 tab 与跨项目伪标签调用", async () => {
    const f = fixture();
    await expect(f.service.tasksFor("main")).rejects.toThrow("仅供 bot 主对话");
    f.agents.set("fake", {
      id: "fake",
      workspaceId: "foreign",
      labels: { "vibe.role": "project", "vibe.project_id": "p" },
      status: "idle",
    });
    await expect(f.service.tasksFor("fake")).rejects.toThrow("仅供 bot 主对话");
  });
  it("只有原生成功投递事件授予原话权限，附带附件且只消费一次", async () => {
    const f = fixture();
    const opened = await f.service.open("p");
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
    const id = (await f.service.open("p")).agentId!;
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
    const id = (await f.service.open("p")).agentId!;
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
    const id = (await f.service.open("p")).agentId!;
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
    const id = (await f.service.open("p")).agentId!;
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


describe("独立 bot 跨项目工具", () => {
  it("只读项目任务并复用真实用户建任务路径，禁止改写与重复消费", async () => {
    const f = fixture();
    f.agents.set("independent", { id: "independent", workspaceId: "bot-home", labels: { "vibe.bot": "bot_independent", "vibe.bot-thread": "main" }, status: "idle" });
    expect((await f.service.projectsFor("independent")).projects).toHaveLength(1);
    expect((await f.service.tasksFor("independent", "p")).plans).toHaveLength(1);
    expect(f.workspaceCreate).not.toHaveBeenCalled();
    await expect(f.service.create("independent", { projectId: "p", text: "用户原话" })).rejects.toThrow("真实用户");
    await f.service.received(f.input("independent") as never);
    await expect(f.service.create("independent", { projectId: "p", text: "改写" })).rejects.toThrow("真实用户");
    await f.service.create("independent", { projectId: "p", text: "用户原话" });
    expect(f.workspaceCreate).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: "worktree", projectId: "p", cwd: "/repo" } }));
    expect(f.sends).toHaveBeenCalledWith("用户原话", expect.objectContaining({ messageId: "project-route:u1", images: [{ mimeType: "image/png", data: "image" }] }));
    await expect(f.service.create("independent", { projectId: "p", text: "用户原话" })).rejects.toThrow("真实用户");
  });
  it("独立 bot 需指定有效项目，项目 bot 不可越项目或读取跨项目列表", async () => {
    const f = fixture();
    f.agents.set("independent", { id: "independent", workspaceId: "bot-home", labels: { "vibe.bot": "bot_independent", "vibe.bot-thread": "main" }, status: "idle" });
    await expect(f.service.tasksFor("independent")).rejects.toThrow("必须指定");
    await expect(f.service.tasksFor("independent", "missing")).rejects.toThrow("项目不存在");
    const own = (await f.service.open("p")).agentId!;
    await expect(f.service.tasksFor(own, "other")).rejects.toThrow("只能操作本项目");
    await expect(f.service.projectsFor(own)).rejects.toThrow("仅供独立 bot");
  });
});
