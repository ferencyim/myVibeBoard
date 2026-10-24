import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEventConsumer,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  publishEvent,
  type VibeDb,
} from "../server/vibe/db";
import { createTaskTabs, formatTabs, tabTitle } from "../server/tabs/service";
import { createTaskFlow } from "../server/tabs/flow";
import { registerTaskRuntime } from "../server/task-runtime";
import {
  TASK_TAB_ROLE_LABEL,
  TASK_TAB_PRESET_LABEL,
  UNRESOLVED_TAB_MODEL,
} from "../server/vibe/contract";

const handles: VibeDb[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

interface FakeAgent {
  id: string;
  workspaceId: string | null;
  provider: string;
  model: string | null;
  thinkingOptionId?: string | null;
  title: string | null;
  status: "idle" | "running" | "error" | "closed";
  activeTurn: { id: string } | null;
  archivedAt?: string | null;
  internal?: boolean;
  labels?: Record<string, string>;
}
interface TimelineEntry {
  item: { type: string; text?: string; messageId?: string };
  turnId?: string | null;
  seqEnd: number;
}

function fakePaseo(options: { directory?: string; projectId?: string } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "vibe-tabs-"));
  const projectId = options.projectId ?? "project-1";
  const agents = new Map<string, FakeAgent>();
  const timelines = new Map<string, TimelineEntry[]>();
  const titles: Array<{ agentId: string; title: string }> = [];
  const appended: Array<{ agentId: string; item: unknown }> = [];
  const sends: Array<{ agentId: string; text: string }> = [];
  const modes: Array<{ agentId: string; modeId: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  let workspaceKind = "worktree";
  let projectKind = "git";

  function addAgent(input: Partial<FakeAgent> & { id: string }): FakeAgent {
    const agent: FakeAgent = {
      workspaceId: "ws",
      provider: "codex",
      model: "first",
      thinkingOptionId: "high",
      title: null,
      status: "idle",
      activeTurn: null,
      ...input,
    };
    agents.set(agent.id, agent);
    return agent;
  }
  function handle(agentId: string) {
    return {
      id: agentId,
      refresh: async () => {},
      current: () => agents.get(agentId),
      setTitle: async (title: string) => {
        const agent = agents.get(agentId);
        if (agent) agent.title = title;
        titles.push({ agentId, title });
      },
      send: async (text: string) => {
        sends.push({ agentId, text });
        const agent = agents.get(agentId);
        if (agent) {
          agent.status = "running";
          agent.activeTurn = { id: "turn-" + sends.length };
        }
      },
      cancelRun: async () => {
        const agent = agents.get(agentId);
        if (agent) {
          agent.status = "idle";
          agent.activeTurn = null;
        }
      },
      setMode: async (modeId: string) => {
        modes.push({ agentId, modeId });
      },
      timeline: {
        refetch: async () => ({
          epoch: "epoch-1",
          entries: timelines.get(agentId) ?? [],
        }),
        append: async (item: unknown) => {
          appended.push({ agentId, item });
        },
      },
    };
  }
  const workspace = {
    workspaceKind,
    projectKind,
    workspaceDirectory: directory,
    projectRootPath: directory + "-root",
    directory,
    projectId,
  };
  const paseo = {
    agents: { ref: (agentId: string) => handle(agentId) },
    workspaces: {
      ref: () => ({
        ...workspace,
        refresh: async () => {},
        current: () => ({ ...workspace, workspaceKind, projectKind }),
        agents: {
          create: async (input: Record<string, unknown>) => {
            created.push(input);
            const config = input.config as { provider: string; modeId?: string };
            const [provider, model] = config.provider.split("/");
            const id = "worker-" + created.length;
            addAgent({
              id,
              provider: provider!,
              model: model ?? "first",
              thinkingOptionId: "high",
              labels: input.labels as Record<string, string>,
            });
            return handle(id);
          },
        },
      }),
    },
  };
  return {
    paseo,
    directory,
    projectId,
    agents,
    titles,
    appended,
    sends,
    modes,
    created,
    addAgent,
    setTimeline(agentId: string, entries: TimelineEntry[]) {
      timelines.set(agentId, entries);
    },
    setWorkspaceKinds(kind: string, project: string) {
      workspaceKind = kind;
      projectKind = project;
    },
  };
}

function setup(options: { git?: Parameters<typeof createTaskFlow>[0]["git"] } = {}) {
  const db = openVibeDb({ path: ":memory:" });
  handles.push(db);
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  store.tasks.markTaskWorkspace("ws");
  const fake = fakePaseo();
  const tabs = createTaskTabs({ store, getPaseo: () => fake.paseo as never });
  const flow = createTaskFlow({
    db,
    store,
    tabs,
    getPaseo: () => fake.paseo as never,
    ...(options.git ? { git: options.git } : {}),
    log: () => {},
  });
  flow.registerPrompts();
  return { db, store, fake, tabs, flow };
}

function planMessage(goal = "完成目标") {
  return [
    "方案如下：",
    "```vibe-plan",
    JSON.stringify(planSnapshot(goal)),
    "```",
  ].join("\n");
}
function planSnapshot(goal = "完成目标") {
  return {
    goal,
    approach: "按步骤实现",
    files: ["src/**"],
    subtasks: [],
    checks: [{ text: "测试通过", method: "运行单测" }],
  };
}
function roleSnapshot(provider = "codex", model = "first") {
  const preset = {
    presetId: "task-tab-native",
    source: "task" as const,
    models: [{ provider, model, thinking: "high", permissionMode: "full" as const }],
    environmentKind: "project-default" as const,
    runtimeEnv: null,
    instructions: "",
  };
  return {
    scout: null,
    planner: preset,
    plan_reviewer: null,
    worker: preset,
    subagent: preset,
    reviewer: null,
    verifier: preset,
  };
}
async function projectTask(
  options: { git?: Parameters<typeof createTaskFlow>[0]["git"] } = {},
) {
  const context = setup(options);
  context.store.projects.create({
    name: "任务项目",
    prefix: "T",
    repoPath: context.fake.directory,
    paseoProjectId: context.fake.projectId,
  });
  context.fake.addAgent({ id: "agent-1" });
  await context.tabs.ensureTab("agent-1");
  return context;
}
async function acceptanceTask(
  options: { git?: Parameters<typeof createTaskFlow>[0]["git"] } = {},
) {
  const context = await projectTask(options);
  const plan = planSnapshot();
  context.store.tasks.savePlan("ws", plan);
  const confirmed = context.store.tasks.confirm("ws", {
    plan,
    rolesSnapshot: roleSnapshot(),
    planSource: { sourceKey: "test" },
    requestId: "confirm-1",
  });
  context.store.tasks.setPhase("ws", "paused");
  context.store.tasks.setPhase("ws", "awaiting_acceptance");
  context.store.taskArtifacts.record({
    workspaceId: "ws",
    kind: "verification",
    sourceKey: "verify:1",
    confirmedAt: confirmed.confirmedAt,
    source: { tabNumber: 1, agentId: "agent-1", sourceKey: "verify:1" },
    summary: "验证通过",
    data: { conclusion: "pass", commitHash: "a".repeat(40) },
  });
  return { ...context, confirmed };
}

describe("任务 tab 编号与标题", () => {
  it("按创建顺序分配固定编号、设置原生标题，并跳过子代理与归档 agent", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });

    const first = await tabs.ensureTab("agent-1");
    expect(first).toMatchObject({ number: 1, agentId: "agent-1", role: "main", model: "first" });
    expect(tabTitle(first!)).toBe("#1 主会话 · first");
    expect(fake.titles.at(-1)).toEqual({ agentId: "agent-1", title: "#1 主会话 · first" });

    fake.addAgent({ id: "agent-2", model: "second" });
    const second = await tabs.ensureTab("agent-2");
    expect(second).toMatchObject({ number: 2, agentId: "agent-2", role: "session" });
    expect(tabTitle(second!)).toBe("#2 会话 · second");

    const again = await tabs.ensureTab("agent-1");
    expect(again?.number).toBe(1);
    expect(store.tasks.get("ws")!.tabs).toHaveLength(2);
    expect(store.tasks.get("ws")!.anchorAgentId).toBe("agent-1");

    fake.addAgent({
      id: "sub-1",
      labels: { [PARENT_AGENT_ID_LABEL]: "agent-1" },
    });
    expect(await tabs.ensureTab("sub-1")).toBeNull();

    fake.addAgent({ id: "agent-3", archivedAt: "2026-01-01T00:00:00.000Z" });
    expect(await tabs.ensureTab("agent-3")).toBeNull();

    fake.agents.get("agent-2")!.status = "closed";
    fake.addAgent({ id: "agent-4" });
    const fourth = await tabs.ensureTab("agent-4");
    expect(fourth?.number).toBe(3);
    expect(store.tasks.get("ws")!.nextTabNumber).toBe(4);
    expect(formatTabs(await tabs.tabsFor(store.tasks.get("ws")!, false))).toContain(
      "#3 会话 · first",
    );
  });

  it("agent 自带角色标签不能授予角色，只有插件声明生效且不改写编号", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    fake.addAgent({ id: "fake-1", labels: { [TASK_TAB_ROLE_LABEL]: "scout" } });
    const plain = await tabs.ensureTab("fake-1");
    expect(plain).toMatchObject({ number: 2, role: "session" });
    const claimed = await tabs.ensureTab("fake-1", { role: "scout" });
    expect(claimed).toMatchObject({ number: 2, role: "scout" });
    expect(fake.titles.at(-1)?.title).toBe("#2 探路 · first");
    fake.agents.get("fake-1")!.labels = { [TASK_TAB_ROLE_LABEL]: "worker" };
    expect((await tabs.ensureTab("fake-1"))?.number).toBe(2);
    expect(store.tasks.get("ws")!.tabs[1]!.role).toBe("scout");
  });

  it("模型未解析时不拼占位模型，解析后更新标题", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1", model: null });
    const first = await tabs.ensureTab("agent-1");
    expect(first).toMatchObject({ number: 1, model: UNRESOLVED_TAB_MODEL });
    expect(tabTitle(first!)).toBe("#1 主会话");
    expect(fake.titles.at(-1)).toEqual({ agentId: "agent-1", title: "#1 主会话" });
    fake.agents.get("agent-1")!.model = "resolved";
    await tabs.tabsFor(store.tasks.get("ws")!, true);
    expect(fake.titles.at(-1)).toEqual({ agentId: "agent-1", title: "#1 主会话 · resolved" });
    expect(store.tasks.get("ws")!.tabs[0]!.model).toBe("resolved");
  });
});

describe("任务 workspace 标记", () => {
  it("只有新任务表单创建的 worktree 成为任务；CLI 与 agent 创建的不算", async () => {
    const { store, tabs } = setup();
    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-ui" },
      agent: { config: {} },
    } as never);
    tabs.claimCreatedWorkspace("ui", "p-ui");
    expect(store.tasks.isTaskWorkspace("ui")).toBe(true);

    tabs.trackWorkspaceCreate({ source: { kind: "worktree", projectId: "p-cli" } } as never);
    tabs.claimCreatedWorkspace("cli", "p-cli");
    expect(store.tasks.isTaskWorkspace("cli")).toBe(false);

    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-agent" },
      agent: { config: {} },
      callerAgentId: "agent-x",
    } as never);
    tabs.claimCreatedWorkspace("agent", "p-agent");
    expect(store.tasks.isTaskWorkspace("agent")).toBe(false);
  });

  it("未标记 workspace 的 agent 不登记；旧任务空清单回填 anchor 为 #1", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "other-1", workspaceId: "other" });
    expect(await tabs.ensureTab("other-1")).toBeNull();
    expect(store.tasks.get("other")).toBeUndefined();

    store.tasks.create({ workspaceId: "legacy", anchorAgentId: "legacy-1" });
    store.tasks.markTaskWorkspace("legacy");
    fake.addAgent({ id: "legacy-1", workspaceId: "legacy" });
    fake.addAgent({ id: "legacy-2", workspaceId: "legacy", model: "second" });
    const second = await tabs.ensureTab("legacy-2");
    expect(second).toMatchObject({ number: 2, role: "session" });
    expect(store.tasks.get("legacy")!.tabs[0]).toMatchObject({
      number: 1,
      agentId: "legacy-1",
      role: "main",
    });
  });
});

describe("插件打开只读 tab", () => {
  it("codex scout 使用只读沙箱并登记编号", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    const opened = await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    expect(opened).toMatchObject({ number: 2, role: "scout", title: "#2 探路 · first" });
    expect(fake.created[0]!.config).toMatchObject({
      provider: "codex/first",
      modeId: "read-only",
      options: { sandbox_mode: "read-only", approval_policy: "never" },
    });
    expect(fake.created[0]!.labels).toEqual({ [TASK_TAB_ROLE_LABEL]: "scout" });
    expect(store.tasks.get("ws")!.tabs[1]).toMatchObject({ role: "scout", model: "first" });
  });

  it("claude 使用 plan 模式；不支持的 provider 拒绝打开", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1", provider: "claude", model: "sonnet" });
    await tabs.ensureTab("agent-1");
    await tabs.openTab("agent-1", { role: "plan_reviewer", task: "复核方案" });
    expect(fake.created[0]!.config).toMatchObject({ provider: "claude/sonnet", modeId: "plan" });

    fake.addAgent({ id: "agent-2", provider: "gemini", model: "pro" });
    await tabs.ensureTab("agent-2");
    await expect(tabs.openTab("agent-2", { role: "scout", task: "调查" })).rejects.toThrow(
      "强制只读策略",
    );
  });
});

describe("任务 tab 交流说明注入", () => {
  it("首次创建包含规划规则、方案格式和空清单", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    const result = (await tabs.injectGuide({
      config: {},
      workspaceId: "ws",
    } as never)) as { config: { systemPrompt?: string } };
    const prompt = result.config.systemPrompt ?? "";
    expect(prompt).toContain("本任务 workspace 由带编号的 tab 组成");
    expect(prompt).toContain("你是任务规划者");
    expect(prompt).toContain("vibe-plan");
    expect(prompt).toContain("（尚无）");
    expect(prompt).toContain("vibe_tabs");
    expect(prompt).not.toContain("wait_for_agent");
  });

  it("已有任务时注入编号清单；会话 tab 不重复注入规划规则", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    const result = (await tabs.injectGuide({
      config: {},
      workspaceId: "ws",
    } as never)) as { config: { systemPrompt?: string } };
    const prompt = result.config.systemPrompt ?? "";
    expect(prompt).toContain("#1 主会话 · first");
    expect(prompt).not.toContain("你是任务规划者");
    expect(store.tasks.get("ws")!.tabs).toHaveLength(1);

    const repeated = (await tabs.injectGuide({
      config: { systemPrompt: prompt },
      workspaceId: "ws",
    } as never)) as { config: { systemPrompt?: string } };
    expect(repeated.config.systemPrompt).toBe(prompt);
  });

  it("角色标签决定角色规则；子代理和不合格 workspace 保持原样", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    const scout = (await tabs.injectGuide({
      config: {},
      workspaceId: "ws",
      labels: { [TASK_TAB_ROLE_LABEL]: "scout" },
    } as never)) as { config: { systemPrompt?: string } };
    expect(scout.config.systemPrompt).toContain("你是只读探路者");

    const request = {
      config: {},
      workspaceId: "ws",
      labels: { [PARENT_AGENT_ID_LABEL]: "agent-1" },
    };
    expect(await tabs.injectGuide(request as never)).toBe(request);

    fake.setWorkspaceKinds("directory", "git");
    const other = { config: {}, workspaceId: "ws" };
    expect(await tabs.injectGuide(other as never)).toBe(other);
  });
});

describe("vibe_tabs", () => {
  it("返回当前任务的编号、角色、模型和状态", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    fake.addAgent({ id: "agent-2", model: "second" });
    await tabs.ensureTab("agent-1");
    await tabs.ensureTab("agent-2");
    fake.agents.get("agent-2")!.activeTurn = { id: "turn" };
    const result = await tabs.vibeTabs("agent-2");
    expect(result).toMatchObject({ workspaceId: "ws", phase: "planning", self: 2 });
    expect(result.tabs).toEqual([
      {
        number: 1,
        agentId: "agent-1",
        role: "main",
        roleLabel: "主会话",
        provider: "codex",
        model: "first",
        status: "空闲",
      },
      {
        number: 2,
        agentId: "agent-2",
        role: "session",
        roleLabel: "会话",
        provider: "codex",
        model: "second",
        status: "运行中",
      },
    ]);
  });
});

describe("打开 tab 的任务流程", () => {
  async function confirmedTask() {
    const context = setup();
    context.store.projects.create({
      name: "任务项目",
      prefix: "T",
      repoPath: context.fake.directory,
      paseoProjectId: context.fake.projectId,
    });
    context.fake.addAgent({ id: "agent-1" });
    await context.tabs.ensureTab("agent-1");
    return context;
  }
  it("/执行 读取当前 tab 最新的 vibe-plan 并进入排队", async () => {
    const { store, fake, flow } = await confirmedTask();
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    const result = await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
    expect(result.message).toContain("等待调度器准入");
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("queued");
    expect(task.plan?.goal).toBe("整理文档");
    expect(task.planSource).toMatchObject({ tabNumber: 1, agentId: "agent-1", sourceKey: "tab:1:epoch-1:3" });
    expect(store.taskArtifacts.list("ws", { kind: "plan" })).toHaveLength(1);
    expect(fake.appended.at(-1)?.item).toMatchObject({ kind: "task-status" });
  });

  it("准入后在 workspace 中打开执行 tab，交付后进入验证阶段", async () => {
    const { db, store, fake, flow } = await confirmedTask();
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    const responder = createEventConsumer({
      db,
      consumer: "test-resources",
      types: ["scheduler.task_resource_request"],
      pollIntervalMs: 2,
      startAt: "now",
      handler: (event) => {
        const payload = event.payload as {
          requestId: string;
          workspaceId: string;
          action: string;
        };
        publishEvent(db, {
          type: "scheduler.task_resource_result",
          payload: {
            requestId: payload.requestId,
            workspaceId: payload.workspaceId,
            ok: true,
            reason: "",
            reservationId: "res-1",
            provider: "codex",
            model: "first",
          },
        });
      },
    });
    responder.start();
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      const queued = store.tasks.get("ws")!;
      const admission = {
        workspaceId: "ws",
        confirmedAt: queued.confirmedAt!,
        role: "worker" as const,
        reservationId: "res-1",
        presetId: "task-tab-native",
        provider: "codex",
        model: "first",
        port: 17121,
        deviceIds: [],
      };
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      await flow.workerAdmitted(admission);

      const executing = store.tasks.get("ws")!;
      expect(executing.phase).toBe("executing");
      expect(executing.tabs).toHaveLength(2);
      expect(executing.tabs[1]).toMatchObject({ number: 2, role: "worker", model: "first" });
      expect(fake.created[0]!.labels).toEqual({
        [TASK_TAB_ROLE_LABEL]: "worker",
        [TASK_TAB_PRESET_LABEL]: "task-tab-native",
      });
      expect(fake.created[0]!.env).toMatchObject({ VIBE_ROLE: "worker", VIBE_WORKSPACE_ID: "ws" });
      expect(fake.sends).toHaveLength(1);
      expect(fake.sends[0]!.text).toContain("整理文档");

      fake.setTimeline("worker-1", [
        {
          item: {
            type: "assistant_message",
            messageId: "m-2",
            text: '```vibe-delivery\n{"status":"completed","summary":"文档已整理"}\n```',
          },
          turnId: "turn-worker",
          seqEnd: 5,
        },
      ]);
      const worker = fake.agents.get("worker-1")!;
      worker.status = "idle";
      worker.activeTurn = null;
      await flow.turnEnded({
        agent: { id: "worker-1", workspaceId: "ws" },
        turnId: "turn-worker",
        outcome: { kind: "completed" },
      });

      const delivered = store.tasks.get("ws")!;
      expect(delivered.phase).toBe("verifying");
      expect(delivered.summary).toContain("#2");
      expect(
        store.taskArtifacts.list("ws", { kind: "delivery" }).map((artifact) => artifact.summary),
      ).toEqual(["文档已整理"]);
    } finally {
      await responder.stop();
    }
  });
});

describe("接手 tab", () => {
  it("/接手 #1 把主会话的角色与进度交给新 tab", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    fake.addAgent({ id: "agent-2", model: "second" });
    await tabs.ensureTab("agent-2");
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: "已完成一半", messageId: "m-1" },
        turnId: "t-1",
        seqEnd: 4,
      },
    ]);
    const result = await flow.handoff({
      workspaceId: "ws",
      agentId: "agent-2",
      requestId: "h-1",
      reason: "#1 继续整理",
    });
    expect(result.message).toContain("接手");
    const task = store.tasks.get("ws")!;
    expect(task.tabs[0]!.role).toBe("session");
    expect(task.tabs[1]!.role).toBe("main");
    expect(fake.sends.at(-1)!.agentId).toBe("agent-2");
    expect(fake.sends.at(-1)!.text).toContain("已完成一半");
    expect(fake.sends.at(-1)!.text).toContain("继续整理");
  });

  it("用户说「继续 #1 的工作」也在回合结束时接手", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    fake.addAgent({ id: "agent-2", model: "second" });
    await tabs.ensureTab("agent-2");
    fake.setTimeline("agent-2", [
      {
        item: { type: "user_message", text: "继续 #1 的工作", messageId: "u-1" },
        turnId: "t-2",
        seqEnd: 9,
      },
    ]);
    await flow.turnEnded({
      agent: { id: "agent-2", workspaceId: "ws" },
      turnId: "t-2",
      outcome: { kind: "completed" },
    });
    const task = store.tasks.get("ws")!;
    expect(task.tabs[0]!.role).toBe("session");
    expect(task.tabs[1]!.role).toBe("main");
    expect(fake.sends.at(-1)!.agentId).toBe("agent-2");
  });

  it("只读角色接手时在新 tab 上强制 provider 只读模式", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    fake.addAgent({ id: "agent-2", provider: "claude", model: "sonnet" });
    await tabs.ensureTab("agent-2");
    await flow.handoff({
      workspaceId: "ws",
      agentId: "agent-2",
      requestId: "h-ro",
      reason: "#2 接手调查",
    });
    const task = store.tasks.get("ws")!;
    expect(task.tabs.find((tab) => tab.agentId === "worker-1")!.role).toBe("session");
    expect(task.tabs.find((tab) => tab.agentId === "agent-2")!.role).toBe("scout");
    expect(fake.modes).toContainEqual({ agentId: "agent-2", modeId: "plan" });
  });

  it("未确认只读模式的 provider 不能接手只读角色", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    fake.addAgent({ id: "agent-2", provider: "gemini", model: "pro" });
    await tabs.ensureTab("agent-2");
    await expect(
      flow.handoff({
        workspaceId: "ws",
        agentId: "agent-2",
        requestId: "h-ro-deny",
        reason: "#2 接手调查",
      }),
    ).rejects.toThrow("强制只读策略");
    const task = store.tasks.get("ws")!;
    expect(task.tabs.find((tab) => tab.agentId === "worker-1")!.role).toBe("scout");
    expect(task.tabs.find((tab) => tab.agentId === "agent-2")!.role).toBe("session");
    expect(fake.sends.some((send) => send.agentId === "agent-2")).toBe(false);
  });

  it("执行 tab 接手时转移 vibe-delivery 角色与资源租约", async () => {
    const { db, store, fake, tabs, flow } = await projectTask();
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    const responder = createEventConsumer({
      db,
      consumer: "test-resources",
      types: ["scheduler.task_resource_request"],
      pollIntervalMs: 2,
      startAt: "now",
      handler: (event) => {
        const payload = event.payload as { requestId: string; workspaceId: string };
        publishEvent(db, {
          type: "scheduler.task_resource_result",
          payload: {
            requestId: payload.requestId,
            workspaceId: payload.workspaceId,
            ok: true,
            reason: "",
            reservationId: "res-1",
            provider: "codex",
            model: "first",
          },
        });
      },
    });
    responder.start();
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      const queued = store.tasks.get("ws")!;
      const admission = {
        workspaceId: "ws",
        confirmedAt: queued.confirmedAt!,
        role: "worker" as const,
        reservationId: "res-1",
        presetId: "task-tab-native",
        provider: "codex",
        model: "first",
        port: 17121,
        deviceIds: [],
      };
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      await flow.workerAdmitted(admission);
      fake.addAgent({ id: "agent-2", model: "first" });
      await tabs.ensureTab("agent-2");
      fake.setTimeline("worker-1", [
        {
          item: { type: "assistant_message", text: "已完成一半改动", messageId: "m-w" },
          turnId: "turn-w",
          seqEnd: 7,
        },
      ]);
      await flow.handoff({
        workspaceId: "ws",
        agentId: "agent-2",
        requestId: "h-2",
        reason: "#2 继续",
      });
      const task = store.tasks.get("ws")!;
      expect(task.tabs.find((tab) => tab.agentId === "worker-1")!.role).toBe("session");
      expect(task.tabs.find((tab) => tab.agentId === "agent-2")!.role).toBe("worker");
      expect(fake.sends.at(-1)!.agentId).toBe("agent-2");
      expect(fake.sends.at(-1)!.text).toContain("vibe-delivery");
      expect(fake.sends.at(-1)!.text).toContain("已完成一半改动");
      expect(flow.runtime.findSessionByAgent("agent-2")).toMatchObject({
        role: "worker",
        previousSessionId: expect.any(String),
      });
    } finally {
      await responder.stop();
    }
  });
});

describe("停止任务", () => {
  it("取消运行中的 tab、释放资源并暂停任务", async () => {
    const { db, store, fake, flow } = await projectTask();
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    const responder = createEventConsumer({
      db,
      consumer: "test-resources-stop",
      types: ["scheduler.task_resource_request"],
      pollIntervalMs: 2,
      startAt: "now",
      handler: (event) => {
        const payload = event.payload as { requestId: string; workspaceId: string };
        publishEvent(db, {
          type: "scheduler.task_resource_result",
          payload: {
            requestId: payload.requestId,
            workspaceId: payload.workspaceId,
            ok: true,
            reason: "",
            reservationId: "res-1",
            provider: "codex",
            model: "first",
          },
        });
      },
    });
    responder.start();
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      const queued = store.tasks.get("ws")!;
      const admission = {
        workspaceId: "ws",
        confirmedAt: queued.confirmedAt!,
        role: "worker" as const,
        reservationId: "res-1",
        presetId: "task-tab-native",
        provider: "codex",
        model: "first",
        port: 17121,
        deviceIds: [],
      };
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      await flow.workerAdmitted(admission);
      expect(fake.agents.get("worker-1")!.activeTurn).not.toBeNull();
      const result = await flow.stop({
        workspaceId: "ws",
        agentId: "agent-1",
        requestId: "s-1",
        reason: "先停下",
      });
      expect(result.message).toContain("任务已停止");
      expect(fake.agents.get("worker-1")!.activeTurn).toBeNull();
      const task = store.tasks.get("ws")!;
      expect(task.phase).toBe("paused");
      expect(task.control?.stoppedReason).toBe("先停下");
    } finally {
      await responder.stop();
    }
  });
});

describe("验收与 Git 收尾", () => {
  it("并发 /通过 只执行一次收尾", async () => {
    const calls: unknown[] = [];
    const git = {
      finalize: async (input: { verifiedCommit: string }) => {
        calls.push(input);
        return {
          status: "blocked" as const,
          verifiedCommit: input.verifiedCommit,
          localMerged: false,
          message: "模拟收尾受阻",
        };
      },
    };
    const { store, flow } = await acceptanceTask({ git });
    const results = await Promise.allSettled([
      flow.accept({ workspaceId: "ws", agentId: "agent-1", requestId: "a-1" }),
      flow.accept({ workspaceId: "ws", agentId: "agent-1", requestId: "a-2" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.tasks.get("ws")!.phase).toBe("paused");
    expect(
      store.taskArtifacts
        .list("ws", { kind: "git" })
        .filter((artifact) => artifact.sourceKey === "accept-request:a-1"),
    ).toHaveLength(1);
  });

  it("最新验证不是本轮通过时拒绝通过", async () => {
    const { store, flow } = await acceptanceTask();
    const confirmedAt = store.tasks.get("ws")!.confirmedAt!;
    store.taskArtifacts.record({
      workspaceId: "ws",
      kind: "verification",
      sourceKey: "verify:2",
      confirmedAt,
      source: { tabNumber: 1, agentId: "agent-1", sourceKey: "verify:2" },
      summary: "验证结论：doubt",
      data: { conclusion: "doubt", commitHash: "b".repeat(40) },
    });
    await expect(
      flow.accept({ workspaceId: "ws", agentId: "agent-1", requestId: "a-3" }),
    ).rejects.toThrow("没有完成且通过的最新验证");
  });

  it("verification_required 收尾后任务转暂停", async () => {
    const git = {
      finalize: async (input: { verifiedCommit: string }) => ({
        status: "verification_required" as const,
        verifiedCommit: input.verifiedCommit,
        localMerged: false,
        message: "需要补充验证",
      }),
    };
    const { store, flow } = await acceptanceTask({ git });
    const result = await flow.accept({
      workspaceId: "ws",
      agentId: "agent-1",
      requestId: "a-4",
      reason: "补充说明",
    });
    expect(result.message).toBe("需要补充验证");
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("paused");
    expect(task.control?.blockingReason).toBe("需要补充验证");
    expect(
      store.taskArtifacts.list("ws", { kind: "git" }).at(-1)!.data,
    ).toMatchObject({ reason: "补充说明" });
  });
});

describe("命令授权", () => {
  it("拒绝 agent 发起的执行/通过/状态命令，用户调用仍可用", async () => {
    const db = openVibeDb({ path: ":memory:" });
    handles.push(db);
    migrateOwner(db, "core");
    const store = createVibeStore(db);
    store.tasks.markTaskWorkspace("ws");
    const fake = fakePaseo();
    fake.addAgent({ id: "agent-1" });
    const tabs = createTaskTabs({ store, getPaseo: () => fake.paseo as never });
    await tabs.ensureTab("agent-1");
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    const server = {
      before: () => () => {},
      on: () => () => {},
      handle: (rpc: { name: string }, fn: (input: unknown, context: unknown) => Promise<unknown>) => {
        handlers.set(rpc.name, fn);
      },
    };
    const runtime = registerTaskRuntime(server as never, {
      db,
      store,
      getPaseo: () => fake.paseo as never,
      onPaseo: () => {},
    });
    try {
      const command = handlers.get("vibe.task.tabs.command")!;
      for (const action of ["execute", "accept", "status"] as const) {
        await expect(
          command(
            { workspaceId: "ws", agentId: "agent-1", action, requestId: "r-" + action },
            { callerAgentId: "agent-2", paseo: fake.paseo },
          ),
        ).rejects.toThrow("agent 消息不能授权任务命令");
      }
      const status = (await command(
        { workspaceId: "ws", agentId: "agent-1", action: "status", requestId: "r-user" },
        { paseo: fake.paseo },
      )) as { message: string };
      expect(status.message).toContain("任务阶段：规划");
    } finally {
      await runtime.close();
    }
  });
});
