import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEventConsumer,
  createTaskRuntimeCommands,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  publishEvent,
  readEvents,
  type VibeDb,
} from "../server/vibe/db";
import {
  createTaskTabs,
  formatTabs,
  HANDOFF_PATTERN,
  tabTitle,
} from "../server/tabs/service";
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

function fakePaseo(
  options: {
    directory?: string;
    projectId?: string;
    models?: Record<string, Array<{ id: string; label: string }>>;
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "vibe-tabs-"));
  const projectId = options.projectId ?? "project-1";
  const agents = new Map<string, FakeAgent>();
  const timelines = new Map<string, TimelineEntry[]>();
  const titles: Array<{ agentId: string; title: string }> = [];
  const appended: Array<{ agentId: string; item: unknown }> = [];
  const sends: Array<{
    agentId: string;
    text: string;
    options?: { sourceAgentId?: string; messageId?: string };
  }> = [];
  const modes: Array<{ agentId: string; modeId: string }> = [];
  const operations: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  let turnCount = 0;
  let createPatch: Partial<FakeAgent> = {};
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
      send: async (
        text: string,
        options?: { sourceAgentId?: string; messageId?: string },
      ) => {
        sends.push({ agentId, text, ...(options ? { options } : {}) });
        operations.push("send:" + agentId);
        const turnId = "turn-" + ++turnCount;
        const agent = agents.get(agentId);
        if (agent) {
          agent.status = "running";
          agent.activeTurn = { id: turnId };
        }
        // Plugin sends carry provenance and project as tool calls, never as user messages.
        const entries = timelines.get(agentId) ?? [];
        entries.push({
          item: options?.sourceAgentId
            ? { type: "tool_call", text, ...(options.messageId ? { messageId: options.messageId } : {}) }
            : { type: "user_message", text, ...(options?.messageId ? { messageId: options.messageId } : {}) },
          turnId,
          seqEnd: entries.length + 1,
        });
        timelines.set(agentId, entries);
      },
      archive: async () => {
        operations.push("archive:" + agentId);
        const agent = agents.get(agentId);
        if (agent) agent.archivedAt = "2026-10-26T00:00:00.000Z";
        return { archivedAt: "2026-10-26T00:00:00.000Z" };
      },
      cancelRun: async () => {
        operations.push("cancel:" + agentId);
        const agent = agents.get(agentId);
        if (agent) {
          agent.status = "idle";
          agent.activeTurn = null;
        }
      },
      setMode: async (modeId: string) => {
        operations.push("mode:" + agentId + ":" + modeId);
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
    ...(options.models
      ? {
          providers: {
            listModels: async (provider: string) => ({
              models: options.models![provider] ?? [],
            }),
          },
        }
      : {}),
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
              ...createPatch,
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
    operations,
    created,
    addAgent,
    setTimeline(agentId: string, entries: TimelineEntry[]) {
      timelines.set(agentId, entries);
    },
    setCreatePatch(patch: Partial<FakeAgent>) {
      createPatch = patch;
    },
    setWorkspaceKinds(kind: string, project: string) {
      workspaceKind = kind;
      projectKind = project;
    },
  };
}

function setup(
  options: {
    git?: Parameters<typeof createTaskFlow>[0]["git"];
    now?: () => number;
    models?: Record<string, Array<{ id: string; label: string }>>;
  } = {},
) {
  const db = openVibeDb({ path: ":memory:" });
  handles.push(db);
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  store.tasks.markTaskWorkspace("ws");
  const fake = fakePaseo(options.models ? { models: options.models } : {});
  const runtime = createTaskRuntimeCommands(db);
  const tabs = createTaskTabs({
    store,
    getPaseo: () => fake.paseo as never,
    sessions: runtime,
    ...(options.now ? { now: options.now } : {}),
  });
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

describe("提示词注册表", () => {
  it("只注册精简后的提示词，旧 key 的覆盖迁移且模板被清理", () => {
    const { store, flow } = setup();
    expect(
      store.prompts
        .list()
        .map((p) => p.key)
        .sort(),
    ).toEqual(
      [
        "task.plan_format",
        "task.role.planner",
        "task.role.scout",
        "task.role.plan_reviewer",
        "board.task.work",
        "task.role.subagent",
        "board.tabs.guide",
        "board.task.continuation",
      ].sort(),
    );

    // Simulate an override saved before WP-122 on a key that was merged away.
    store.prompts.register([
      {
        key: "board.task.plan",
        plugin: "vibe-board",
        role: "planner",
        title: "旧规划",
        defaultText: "old",
      },
    ]);
    store.prompts.setOverride("board.task.plan", "旧的规划覆盖");
    flow.registerPrompts();

    expect(store.prompts.body("task.role.planner").source).toBe("global");
    expect(store.prompts.resolve("task.role.planner", { vars: { tabs: "" } })).toContain(
      "旧的规划覆盖",
    );
    expect(store.prompts.list().some((p) => p.key === "board.task.plan")).toBe(false);
    expect(store.prompts.orphans()).toEqual([]);
  });
});

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

  it("标题显示 provider 模型目录的可读名称，取不到时回退模型 id", async () => {
    const { fake, tabs } = setup({
      models: { qoder: [{ id: "dfmodel", label: "DeepSeek-Flash" }] },
    });
    fake.addAgent({ id: "agent-1", provider: "qoder", model: "dfmodel" });
    const first = await tabs.ensureTab("agent-1");
    expect(first).toMatchObject({ model: "dfmodel", modelLabel: "DeepSeek-Flash" });
    expect(fake.titles.at(-1)).toEqual({ agentId: "agent-1", title: "#1 主会话 · DeepSeek-Flash" });

    fake.addAgent({ id: "agent-2", provider: "qoder", model: "unknown-id" });
    const second = await tabs.ensureTab("agent-2");
    expect(second).toMatchObject({ number: 2, model: "unknown-id" });
    expect(second!.modelLabel).toBeUndefined();
    expect(fake.titles.at(-1)).toEqual({ agentId: "agent-2", title: "#2 会话 · unknown-id" });
  });

  it("快速结束的首回合在 tab 尚未登记时补登记并保存方案", async () => {
    const { store, fake, flow } = setup();
    store.tasks.create({ workspaceId: "ws", anchorAgentId: "agent-1" });
    fake.addAgent({ id: "agent-1" });
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("快速方案"), messageId: "m-fast" },
        turnId: "turn-fast",
        seqEnd: 2,
      },
    ]);
    await flow.turnEnded({
      agent: { id: "agent-1", workspaceId: "ws" },
      turnId: "turn-fast",
      outcome: { kind: "completed" },
    });
    const task = store.tasks.get("ws")!;
    expect(task.plan?.goal).toBe("快速方案");
    expect(task.tabs).toMatchObject([{ number: 1, agentId: "agent-1", role: "main" }]);
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
      workspaceId: "ui",
    } as never);
    tabs.claimCreatedWorkspace("ui");
    expect(store.tasks.isTaskWorkspace("ui")).toBe(true);

    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-cli" },
      workspaceId: "cli",
    } as never);
    tabs.claimCreatedWorkspace("cli");
    expect(store.tasks.isTaskWorkspace("cli")).toBe(false);

    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-agent" },
      agent: { config: {} },
      callerAgentId: "agent-x",
      workspaceId: "agent",
    } as never);
    tabs.claimCreatedWorkspace("agent");
    expect(store.tasks.isTaskWorkspace("agent")).toBe(false);
  });

  it("并发创建按预分配 id 认领，不会认领到同项目的另一个 workspace", async () => {
    const { store, tabs } = setup();
    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-same" },
      agent: { config: {} },
      workspaceId: "first",
    } as never);
    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-same" },
      agent: { config: {} },
      workspaceId: "second",
    } as never);
    tabs.claimCreatedWorkspace("second");
    expect(store.tasks.isTaskWorkspace("second")).toBe(true);
    expect(store.tasks.isTaskWorkspace("first")).toBe(false);
    tabs.claimCreatedWorkspace("first");
    expect(store.tasks.isTaskWorkspace("first")).toBe(true);
    tabs.claimCreatedWorkspace("unknown");
    expect(store.tasks.isTaskWorkspace("unknown")).toBe(false);
  });

  it("创建失败或超时的记录不会被之后的 workspace 认领", async () => {
    let clock = 1_000;
    const { store, tabs } = setup({ now: () => clock });
    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-ui" },
      agent: { config: {} },
      workspaceId: "failed-create",
    } as never);
    clock += 5 * 60_000 + 1;
    tabs.claimCreatedWorkspace("failed-create");
    expect(store.tasks.isTaskWorkspace("failed-create")).toBe(false);
    tabs.trackWorkspaceCreate({
      source: { kind: "worktree", projectId: "p-ui" },
      agent: { config: {} },
      workspaceId: "later",
    } as never);
    tabs.claimCreatedWorkspace("later");
    expect(store.tasks.isTaskWorkspace("later")).toBe(true);
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

describe("插件打开 tab", () => {
  it("按当前 tab 的模型打开 scout，先建 agent 再以来源身份发送任务", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    const opened = await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    expect(opened).toMatchObject({ number: 2, role: "scout", title: "#2 探路 · first" });
    expect(fake.created[0]!.config).toEqual({ provider: "codex/first" });
    expect(fake.created[0]).not.toHaveProperty("prompt");
    expect(fake.created[0]!.labels).toEqual({ [TASK_TAB_ROLE_LABEL]: "scout" });
    expect(fake.sends).toEqual([
      {
        agentId: opened.agentId,
        text: expect.stringContaining("调查入口"),
        options: { sourceAgentId: "agent-1" },
      },
    ]);
    expect(store.tasks.get("ws")!.tabs[1]).toMatchObject({ role: "scout", model: "first" });
  });

  it("任意 provider 都可打开探路/复核 tab，且不传未知 modeId", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1", provider: "gemini", model: "pro" });
    await tabs.ensureTab("agent-1");
    await tabs.openTab("agent-1", { role: "plan_reviewer", task: "复核方案" });
    expect(fake.created[0]!.config).toEqual({ provider: "gemini/pro" });
    expect(fake.created[0]!.config).not.toHaveProperty("modeId");
    expect(fake.created[0]!.config).not.toHaveProperty("options");
  });

  it("会话 tab 不强制模式，但仍以来源身份发送任务", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    const opened = await tabs.openTab("agent-1", { role: "session", task: "整理资料" });
    expect(fake.created[0]!.config).toEqual({ provider: "codex/first" });
    expect(fake.sends.at(-1)).toMatchObject({
      agentId: opened.agentId,
      options: { sourceAgentId: "agent-1" },
    });
  });
});

describe("插件消息不触发验收与接手", () => {
  it("vibe_open_tab 的 task 为「通过」时不会被当成用户验收", async () => {
    const calls: unknown[] = [];
    const git = {
      finalize: async (input: { verifiedCommit: string }) => {
        calls.push(input);
        return {
          status: "blocked" as const,
          verifiedCommit: input.verifiedCommit,
          localMerged: false,
          message: "不应触发收尾",
        };
      },
    };
    const { store, fake, tabs, flow } = await acceptanceTask({ git });
    const opened = await tabs.openTab("agent-1", { role: "session", task: "通过" });
    const agent = fake.agents.get(opened.agentId)!;
    const turnId = agent.activeTurn!.id;
    agent.status = "idle";
    agent.activeTurn = null;
    await flow.turnEnded({
      agent: { id: opened.agentId, workspaceId: "ws" },
      turnId,
      outcome: { kind: "completed" },
    });
    expect(calls).toHaveLength(0);
    expect(store.tasks.get("ws")!.phase).toBe("awaiting_acceptance");
  });

  it("vibe_open_tab 的 task 为「继续 #3 的工作」时不会触发接手", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    fake.addAgent({ id: "agent-2", model: "second" });
    await tabs.ensureTab("agent-2", { role: "reviewer" });
    const opened = await tabs.openTab("agent-1", {
      role: "session",
      task: "继续 #3 的工作",
    });
    const agent = fake.agents.get(opened.agentId)!;
    const turnId = agent.activeTurn!.id;
    agent.status = "idle";
    agent.activeTurn = null;
    await flow.turnEnded({
      agent: { id: opened.agentId, workspaceId: "ws" },
      turnId,
      outcome: { kind: "completed" },
    });
    const task = store.tasks.get("ws")!;
    expect(task.tabs.find((tab) => tab.agentId === "agent-2")!.role).toBe("reviewer");
    expect(task.tabs.find((tab) => tab.agentId === opened.agentId)!.role).toBe("session");
    expect(fake.sends).toHaveLength(2);
    expect(fake.modes).toHaveLength(0);
  });

  it("真实用户消息「通过」仍然触发验收", async () => {
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
    const { store, fake, flow } = await acceptanceTask({ git });
    fake.setTimeline("agent-1", [
      {
        item: { type: "user_message", text: "通过", messageId: "u-pass" },
        turnId: "t-pass",
        seqEnd: 4,
      },
    ]);
    fake.agents.get("agent-1")!.activeTurn = null;
    await flow.turnEnded({
      agent: { id: "agent-1", workspaceId: "ws" },
      turnId: "t-pass",
      outcome: { kind: "completed" },
    });
    expect(calls).toHaveLength(1);
    expect(store.tasks.get("ws")!.phase).toBe("paused");
  });
});

describe("接手短语匹配", () => {
  it("只接受整条消息的两种形式，句中提到不算", () => {
    expect(HANDOFF_PATTERN.test("继续 #3 的工作")).toBe(true);
    expect(HANDOFF_PATTERN.test("  继续 #3 的工作  ")).toBe(true);
    expect(HANDOFF_PATTERN.test("/接手 #3")).toBe(true);
    expect(HANDOFF_PATTERN.test("接手3")).toBe(true);
    expect(HANDOFF_PATTERN.test("我来接手 3 个问题")).toBe(false);
    expect(HANDOFF_PATTERN.test("请继续 #3 的工作，谢谢")).toBe(false);
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

  it("agent 标签不决定角色规则；子代理只注入子任务规则，不合格 workspace 保持原样", async () => {
    const { fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    const labeled = (await tabs.injectGuide({
      config: {},
      workspaceId: "ws",
      labels: { [TASK_TAB_ROLE_LABEL]: "scout" },
    } as never)) as { config: { systemPrompt?: string } };
    expect(labeled.config.systemPrompt).toContain("本任务 workspace 由带编号的 tab 组成");
    expect(labeled.config.systemPrompt).not.toContain("你是只读探路者");

    const request = {
      config: {},
      workspaceId: "ws",
      labels: { [PARENT_AGENT_ID_LABEL]: "agent-1" },
    };
    const subagent = (await tabs.injectGuide(request as never)) as {
      config: { systemPrompt?: string };
    };
    expect(subagent.config.systemPrompt).toContain("你是执行子代理");
    expect(subagent.config.systemPrompt).toContain("vibe-delivery");

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

  it("/执行 允许任意 provider 担任复核角色（复核仅靠提示词只读）", async () => {
    const { store, fake, flow } = await confirmedTask();
    store.presets.create({
      id: "p-core",
      name: "核心",
      provider: "codex",
      model: "first",
      thinking: "high",
      permissionMode: "full",
    });
    store.presets.create({
      id: "p-gemini",
      name: "Gemini 复核",
      provider: "gemini",
      model: "pro",
      permissionMode: "full",
    });
    store.tasks.setRoleSelections("ws", {
      planner: { mode: "preset", presetId: "p-core" },
      worker: { mode: "preset", presetId: "p-core" },
      subagent: { mode: "preset", presetId: "p-core" },
      verifier: { mode: "preset", presetId: "p-core" },
      reviewer: { mode: "preset", presetId: "p-gemini" },
    });
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    const result = await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
    expect(result.task.phase).toBe("queued");
    expect(store.tasks.get("ws")!.rolesSnapshot?.reviewer?.models[0]!.provider).toBe("gemini");
    expect(store.taskArtifacts.list("ws", { kind: "plan" })).toHaveLength(1);
  });

  it("/执行 允许验证角色使用可写 provider", async () => {
    const { store, fake, flow } = await confirmedTask();
    store.presets.create({
      id: "p-core",
      name: "核心",
      provider: "codex",
      model: "first",
      thinking: "high",
      permissionMode: "full",
    });
    store.presets.create({
      id: "p-verify",
      name: "验证",
      provider: "gemini",
      model: "pro",
      permissionMode: "auto",
    });
    store.tasks.setRoleSelections("ws", {
      planner: { mode: "preset", presetId: "p-core" },
      worker: { mode: "preset", presetId: "p-core" },
      subagent: { mode: "preset", presetId: "p-core" },
      verifier: { mode: "preset", presetId: "p-verify" },
      reviewer: { mode: "disabled" },
    });
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    const result = await flow.execute({
      workspaceId: "ws",
      agentId: "agent-1",
      requestId: "r-2",
    });
    expect(result.task.phase).toBe("queued");
    expect(store.tasks.get("ws")!.rolesSnapshot?.verifier?.models[0]!.provider).toBe("gemini");
    expect(store.tasks.get("ws")!.rolesSnapshot?.reviewer).toBeNull();
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

  it("用户说「继续 #1 的工作」（允许首尾空白）也在回合结束时接手", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    fake.addAgent({ id: "agent-2", model: "second" });
    await tabs.ensureTab("agent-2");
    fake.setTimeline("agent-2", [
      {
        item: { type: "user_message", text: "  继续 #1 的工作  ", messageId: "u-1" },
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
    expect(fake.sends.at(-1)!.options).toEqual({ sourceAgentId: "agent-1" });
  });

  it("自然语言接手只匹配整条消息，不因句中包含编号而触发", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    fake.addAgent({ id: "agent-2", model: "second" });
    await tabs.ensureTab("agent-2");
    fake.setTimeline("agent-2", [
      {
        item: { type: "user_message", text: "我来接手 3 个问题", messageId: "u-2" },
        turnId: "t-3",
        seqEnd: 9,
      },
    ]);
    await flow.turnEnded({
      agent: { id: "agent-2", workspaceId: "ws" },
      turnId: "t-3",
      outcome: { kind: "completed" },
    });
    const task = store.tasks.get("ws")!;
    expect(task.tabs.find((tab) => tab.agentId === "worker-1")!.role).toBe("scout");
    expect(task.tabs.find((tab) => tab.agentId === "agent-2")!.role).toBe("session");
    expect(fake.sends).toHaveLength(1);
  });

  it("主会话 tab 即使说「继续 #2 的工作」也不会被改成其他角色", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    const sendsBefore = fake.sends.length;
    fake.setTimeline("agent-1", [
      {
        item: { type: "user_message", text: "继续 #2 的工作", messageId: "u-3" },
        turnId: "t-4",
        seqEnd: 9,
      },
    ]);
    await flow.turnEnded({
      agent: { id: "agent-1", workspaceId: "ws" },
      turnId: "t-4",
      outcome: { kind: "completed" },
    });
    const task = store.tasks.get("ws")!;
    expect(task.tabs.find((tab) => tab.agentId === "agent-1")!.role).toBe("main");
    expect(task.tabs.find((tab) => tab.agentId === "worker-1")!.role).toBe("scout");
    expect(fake.sends).toHaveLength(sendsBefore);
    expect(fake.modes).toHaveLength(0);
  });

  it("接手前先停止目标 tab 的运行中回合", async () => {
    const { fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    fake.addAgent({
      id: "agent-2",
      provider: "claude",
      model: "sonnet",
      status: "running",
      activeTurn: { id: "busy" },
    });
    await tabs.ensureTab("agent-2");
    fake.operations.length = 0;
    await flow.handoff({
      workspaceId: "ws",
      agentId: "agent-2",
      requestId: "h-3",
      reason: "#2 接手调查",
    });
    const cancelled = fake.operations.indexOf("cancel:agent-2");
    const sent = fake.operations.indexOf("send:agent-2");
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(cancelled);
    expect(fake.modes).toHaveLength(0);
  });

  it("任意 provider 的会话 tab 都能接手只读角色（不再切换模式）", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    fake.addAgent({ id: "agent-2", provider: "gemini", model: "pro" });
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
    expect(fake.modes).toHaveLength(0);
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

describe("上下文接续", () => {
  it("scout 接续会打开新 tab、继承角色与进度、写入会话链并回写结果", async () => {
    const { db, store, fake, tabs, flow } = await projectTask();
    const scout = await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    const oldSession = flow.runtime.findSessionByAgent(scout.agentId)!;
    expect(oldSession.role).toBe("scout");
    fake.setTimeline(scout.agentId, [
      {
        item: { type: "assistant_message", text: "已完成一半调查", messageId: "m-s" },
        turnId: "turn-s",
        seqEnd: 5,
      },
    ]);
    store.tasks.setPhase("ws", "paused");
    const result = await flow.continuation({
      requestId: "cont-1",
      workspaceId: "ws",
      agentId: scout.agentId,
      role: "scout",
      reason: "context",
      message: "上下文接续",
      summary: "#2 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
      previousPhase: "planning",
    });
    expect(result.message).toContain("已打开接续 tab");
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("planning");
    expect(task.tabs.find((tab) => tab.agentId === scout.agentId)!.role).toBe("session");
    const next = task.tabs.at(-1)!;
    expect(next.role).toBe("scout");
    expect(fake.created.at(-1)).toMatchObject({
      config: { provider: "codex/first", modeId: "auto", thinkingOptionId: "high" },
      env: { VIBE_ROLE: "scout", VIBE_WORKSPACE_ID: "ws" },
      labels: { [TASK_TAB_ROLE_LABEL]: "scout" },
    });
    const sent = fake.sends.at(-1)!;
    expect(sent.agentId).toBe(next.agentId);
    expect(sent.options).toEqual({ sourceAgentId: scout.agentId });
    expect(sent.text).toContain("已完成一半调查");
    // Plugin-to-plugin prompts stay in the tool-call lane, so a completed turn cannot authorise
    // acceptance or handoff even if its text contains a handoff phrase.
    const page = await fake.paseo.agents.ref(next.agentId).timeline.refetch();
    const entry = page.entries.at(-1)!;
    expect(entry.item.type).toBe("tool_call");
    const sendsBeforeTurn = fake.sends.length;
    await flow.turnEnded({
      agent: { id: next.agentId, workspaceId: "ws" },
      turnId: entry.turnId ?? null,
      outcome: { kind: "completed" },
    });
    expect(fake.sends).toHaveLength(sendsBeforeTurn);
    expect(store.tasks.get("ws")!.tabs.at(-1)!.role).toBe("scout");
    expect(flow.runtime.findSessionByAgent(next.agentId)).toMatchObject({
      role: "scout",
      previousSessionId: oldSession.id,
      candidateIndex: 0,
    });
    const results = readEvents(db, 0, { types: ["context.continuation_result"] });
    expect(results.at(-1)!.payload).toMatchObject({
      requestId: "cont-1",
      workspaceId: "ws",
      status: "continued",
      agentId: next.agentId,
      sessionId: flow.runtime.findSessionByAgent(next.agentId)!.id,
      candidateIndex: 0,
    });
    expect(store.tasks.get("ws")!.control).toMatchObject({
      continuationRequestId: "cont-1",
      continuationResult: { status: "continued", agentId: next.agentId },
    });

    const sends = fake.sends.length;
    const created = fake.created.length;
    const replay = await flow.continuation({
      requestId: "cont-1",
      workspaceId: "ws",
      agentId: scout.agentId,
      role: "scout",
      reason: "context",
      message: "上下文接续",
      summary: "#2 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
      previousPhase: "planning",
    });
    expect(replay.message).toContain("已打开接续 tab");
    expect(fake.sends).toHaveLength(sends);
    expect(fake.created).toHaveLength(created);
  });

  it("main 的接续按 planner 会话写入链路并恢复原阶段", async () => {
    const { store, fake, flow } = await projectTask();
    const oldSession = flow.runtime.findSessionByAgent("agent-1")!;
    expect(oldSession.role).toBe("planner");
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: "主会话已整理目标", messageId: "m-p" },
        turnId: "turn-p",
        seqEnd: 3,
      },
    ]);
    store.tasks.setPhase("ws", "paused");
    const result = await flow.continuation({
      requestId: "cont-main",
      workspaceId: "ws",
      agentId: "agent-1",
      role: "planner",
      reason: "context",
      message: "主会话上下文接续",
      summary: "#1 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
      previousPhase: "planning",
    });
    expect(result.message).toContain("已打开接续 tab");
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("planning");
    expect(task.tabs.find((tab) => tab.agentId === "agent-1")!.role).toBe("session");
    const next = task.tabs.at(-1)!;
    expect(next.role).toBe("main");
    expect(fake.sends.at(-1)!.agentId).toBe(next.agentId);
    expect(fake.sends.at(-1)!.options).toEqual({ sourceAgentId: "agent-1" });
    expect(fake.sends.at(-1)!.text).toContain("主会话已整理目标");
    expect(flow.runtime.findSessionByAgent(next.agentId)).toMatchObject({
      role: "planner",
      previousSessionId: oldSession.id,
    });
  });

  it("worker 失败接续按确认快照切换到下一个候选模型", async () => {
    const { db, store, fake, tabs, flow } = await projectTask();
    fake.addAgent({ id: "agent-w", provider: "codex", model: "first" });
    await tabs.ensureTab("agent-w", { role: "worker" });
    const plan = planSnapshot();
    store.tasks.savePlan("ws", plan);
    const base = roleSnapshot();
    const confirmed = store.tasks.confirm("ws", {
      plan,
      rolesSnapshot: {
        ...base,
        worker: {
          ...base.worker!,
          models: [
            { provider: "codex", model: "first", thinking: "high", permissionMode: "full" },
            { provider: "codex", model: "second", thinking: "high", permissionMode: "auto" },
          ],
        },
      },
      planSource: { sourceKey: "test" },
      requestId: "confirm-worker",
    });
    const oldSession = flow.runtime.registerSession({
      workspaceId: "ws",
      projectId: fake.projectId,
      agentId: "agent-w",
      role: "worker",
      provider: "codex",
      model: "first",
      thinking: "high",
      candidateIndex: 0,
      confirmedAt: confirmed.confirmedAt,
    });
    store.tasks.setPhase("ws", "paused");
    const responder = createEventConsumer({
      db,
      consumer: "test-continuation-resources",
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
            reservationId: "res-cont",
            provider: "codex",
            model: "second",
          },
        });
      },
    });
    responder.start();
    try {
      const result = await flow.continuation({
        requestId: "cont-worker",
        workspaceId: "ws",
        agentId: "agent-w",
        role: "worker",
        reason: "failure",
        message: "执行失败，切换候选",
        summary: "#2 执行失败",
        candidateIndex: 0,
        confirmedAt: confirmed.confirmedAt,
        prompt: "",
        previousPhase: "executing",
      });
      expect(result.message).toContain("已打开接续 tab");
      const task = store.tasks.get("ws")!;
      expect(task.phase).toBe("executing");
      expect(task.tabs.find((tab) => tab.agentId === "agent-w")!.role).toBe("session");
      const next = task.tabs.find((tab) => tab.role === "worker")!;
      expect(next.agentId).not.toBe("agent-w");
      expect(fake.created.at(-1)).toMatchObject({
        config: { provider: "codex/second", modeId: "auto", thinkingOptionId: "high" },
        env: { VIBE_ROLE: "worker", VIBE_WORKSPACE_ID: "ws" },
        labels: {
          [TASK_TAB_ROLE_LABEL]: "worker",
          [TASK_TAB_PRESET_LABEL]: "task-tab-native",
        },
      });
      expect(fake.sends.at(-1)!.options).toEqual({ sourceAgentId: "agent-w" });
      expect(flow.runtime.findSessionByAgent(next.agentId)).toMatchObject({
        role: "worker",
        currentProvider: "codex",
        model: "second",
        candidateIndex: 1,
        previousSessionId: oldSession.id,
        confirmedAt: confirmed.confirmedAt,
      });
      expect(flow.runtime.getSession(oldSession.id)!.state).toBe("ended");
      const results = readEvents(db, 0, { types: ["context.continuation_result"] });
      expect(results.at(-1)!.payload).toMatchObject({
        requestId: "cont-worker",
        status: "continued",
        agentId: next.agentId,
        candidateIndex: 1,
      });
    } finally {
      await responder.stop();
    }
  });

  it("失败接续没有候选时标记 exhausted 且不创建 tab", async () => {
    const { db, store, fake, tabs, flow } = await projectTask();
    fake.addAgent({ id: "worker-1", provider: "codex", model: "first" });
    await tabs.ensureTab("worker-1", { role: "worker" });
    const plan = planSnapshot();
    store.tasks.savePlan("ws", plan);
    const confirmed = store.tasks.confirm("ws", {
      plan,
      rolesSnapshot: roleSnapshot(),
      planSource: { sourceKey: "test" },
      requestId: "confirm-exhausted",
    });
    flow.runtime.registerSession({
      workspaceId: "ws",
      projectId: fake.projectId,
      agentId: "worker-1",
      role: "worker",
      provider: "codex",
      model: "first",
      candidateIndex: 0,
      confirmedAt: confirmed.confirmedAt,
    });
    store.tasks.setPhase("ws", "paused");
    const before = fake.created.length;
    const result = await flow.continuation({
      requestId: "cont-exhausted",
      workspaceId: "ws",
      agentId: "worker-1",
      role: "worker",
      reason: "failure",
      message: "执行失败",
      summary: "#2 执行失败",
      candidateIndex: 0,
      confirmedAt: confirmed.confirmedAt,
      prompt: "",
      previousPhase: "executing",
    });
    expect(result.message).toContain("耗尽");
    expect(fake.created).toHaveLength(before);
    expect(fake.sends).toHaveLength(0);
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("paused");
    expect(task.tabs.filter((tab) => tab.role === "worker")).toHaveLength(1);
    expect(task.control).toMatchObject({
      continuationRequestId: "cont-exhausted",
      continuationResult: { status: "exhausted" },
    });
    const results = readEvents(db, 0, { types: ["context.continuation_result"] });
    expect(results.at(-1)!.payload).toMatchObject({
      requestId: "cont-exhausted",
      status: "exhausted",
    });
  });

  it("缺少可恢复阶段时保持暂停且不打开 tab", async () => {
    const { db, store, fake, tabs, flow } = await projectTask();
    const scout = await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    store.tasks.setPhase("ws", "paused");
    const created = fake.created.length;
    const sends = fake.sends.length;
    const result = await flow.continuation({
      requestId: "cont-norestore",
      workspaceId: "ws",
      agentId: scout.agentId,
      role: "scout",
      reason: "context",
      message: "上下文接续",
      summary: "#2 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
    });
    expect(result.message).toContain("不能自动恢复");
    expect(fake.created).toHaveLength(created);
    expect(fake.sends).toHaveLength(sends);
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("paused");
    expect(task.tabs.find((tab) => tab.agentId === scout.agentId)!.role).toBe("scout");
    expect(task.control).toMatchObject({
      continuationRequestId: "cont-norestore",
      continuationResult: { status: "paused" },
    });
    const results = readEvents(db, 0, { types: ["context.continuation_result"] });
    expect(results.at(-1)!.payload).toMatchObject({
      requestId: "cont-norestore",
      status: "paused",
    });
  });

  it("接续请求之后用户停止了任务时保持暂停", async () => {
    const { db, store, fake, tabs, flow } = await projectTask();
    const scout = await tabs.openTab("agent-1", { role: "scout", task: "调查入口" });
    store.tasks.setPhase("ws", "paused");
    store.tasks.updateControl("ws", { stoppedAt: "2026-10-24T12:00:10.000Z" });
    const created = fake.created.length;
    const sends = fake.sends.length;
    const result = await flow.continuation({
      requestId: "cont-stopped",
      workspaceId: "ws",
      agentId: scout.agentId,
      role: "scout",
      reason: "context",
      message: "上下文接续",
      summary: "#2 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
      previousPhase: "planning",
      requestedAt: "2026-10-24T12:00:00.000Z",
    });
    expect(result.message).toContain("用户停止");
    expect(fake.created).toHaveLength(created);
    expect(fake.sends).toHaveLength(sends);
    expect(store.tasks.get("ws")!.phase).toBe("paused");
    const results = readEvents(db, 0, { types: ["context.continuation_result"] });
    expect(results.at(-1)!.payload).toMatchObject({
      requestId: "cont-stopped",
      status: "paused",
    });
  });

  it("排队阶段不能从暂停恢复，保持暂停且不打开 tab", async () => {
    const { store, fake, flow } = await projectTask();
    store.tasks.setPhase("ws", "paused");
    const created = fake.created.length;
    const result = await flow.continuation({
      requestId: "cont-queued",
      workspaceId: "ws",
      agentId: "agent-1",
      role: "planner",
      reason: "context",
      message: "主会话上下文接续",
      summary: "#1 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
      previousPhase: "queued",
    });
    expect(result.message).toContain("不能自动恢复");
    expect(fake.created).toHaveLength(created);
    expect(store.tasks.get("ws")!.phase).toBe("paused");
  });

  it("等待确认的任务接续后恢复等待确认阶段并打开接续 tab", async () => {
    const { store, fake, flow } = await projectTask();
    store.tasks.savePlan("ws", planSnapshot());
    expect(store.tasks.get("ws")!.phase).toBe("awaiting_confirmation");
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: "方案已就绪", messageId: "m-await" },
        turnId: "turn-await",
        seqEnd: 4,
      },
    ]);
    store.tasks.setPhase("ws", "paused");
    const result = await flow.continuation({
      requestId: "cont-await",
      workspaceId: "ws",
      agentId: "agent-1",
      role: "planner",
      reason: "context",
      message: "主会话上下文接续",
      summary: "#1 上下文已满",
      candidateIndex: 0,
      confirmedAt: null,
      prompt: "",
      previousPhase: "awaiting_confirmation",
    });
    expect(result.message).toContain("已打开接续 tab");
    const task = store.tasks.get("ws")!;
    expect(task.phase).toBe("awaiting_confirmation");
    expect(task.plan).toEqual(planSnapshot());
    expect(task.tabs.find((tab) => tab.agentId === "agent-1")!.role).toBe("session");
    expect(task.tabs.at(-1)!.role).toBe("main");
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

  it("Git 收尾进行中 /停止任务 会先在安全点发出取消信号", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((done) => {
      markStarted = done;
    });
    let cancelledAtSafePoint: boolean | undefined;
    const git = {
      finalize: async (input: { verifiedCommit: string; isCancelled?: () => boolean }) => {
        markStarted();
        await held;
        cancelledAtSafePoint = input.isCancelled?.();
        return {
          status: "blocked" as const,
          verifiedCommit: input.verifiedCommit,
          localMerged: false,
          message: "已停止收尾",
        };
      },
    };
    const { db, store, flow } = await acceptanceTask({ git });
    const responder = createEventConsumer({
      db,
      consumer: "test-resources-accept-stop",
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
          },
        });
      },
    });
    responder.start();
    try {
      const accepting = flow.accept({
        workspaceId: "ws",
        agentId: "agent-1",
        requestId: "a-stop",
      });
      await started;
      const stopping = flow.stop({
        workspaceId: "ws",
        agentId: "agent-1",
        requestId: "s-stop",
        reason: "中止收尾",
      });
      release();
      await accepting;
      await stopping;
      expect(cancelledAtSafePoint).toBe(true);
      expect(store.tasks.get("ws")!.control?.stoppedReason).toBe("中止收尾");
    } finally {
      await responder.stop();
    }
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

function configurePresets(
  store: ReturnType<typeof createVibeStore>,
  options: { reviewer?: boolean; scout?: boolean } = {},
) {
  const make = (id: string, provider: string, model: string) =>
    store.presets.create({
      id,
      name: id,
      provider,
      model,
      thinking: "high",
      permissionMode: "full",
    });
  const planner = make("p-planner", "codex", "planner-model");
  const worker = make("p-worker", "codex", "second");
  const scout = make("p-scout", "codex", "scout-model");
  const reviewer = make("p-reviewer", "codex", "review-model");
  const verifier = make("p-verifier", "gemini", "verify-model");
  store.modelDefaults.setGlobal({
    planner: planner.id,
    worker: worker.id,
    verifier: verifier.id,
    scout: options.scout === false ? null : scout.id,
    reviewer: options.reviewer === false ? null : reviewer.id,
  });
  return { planner, worker, scout, reviewer, verifier };
}

describe("预建流程 tab", () => {
  it("新建任务按默认模型预建探路、执行、复核、验证 tab，且不发初始 prompt", async () => {
    const { store, fake, flow } = await projectTask();
    configurePresets(store);
    await flow.provisionTabs("ws");
    const task = store.tasks.get("ws")!;
    expect(task.tabs.map((tab) => [tab.number, tab.role, tab.model])).toEqual([
      [1, "main", "first"],
      [2, "scout", "scout-model"],
      [3, "worker", "second"],
      [4, "reviewer", "review-model"],
      [5, "verifier", "verify-model"],
    ]);
    expect(fake.created).toHaveLength(4);
    for (const created of fake.created) expect(created).not.toHaveProperty("prompt");
    await flow.provisionTabs("ws");
    expect(store.tasks.get("ws")!.tabs).toHaveLength(5);
    expect(fake.created).toHaveLength(4);
  });

  it("探路或复核默认不启用时不建对应 tab，编号仍连续", async () => {
    const { store, fake, flow } = await projectTask();
    configurePresets(store, { scout: false, reviewer: false });
    await flow.provisionTabs("ws");
    expect(store.tasks.get("ws")!.tabs.map((tab) => [tab.number, tab.role])).toEqual([
      [1, "main"],
      [2, "worker"],
      [3, "verifier"],
    ]);
    expect(fake.created).toHaveLength(2);
  });

  it("交流说明列出自身编号、上下游和预建的其它角色 tab", async () => {
    const { store, tabs } = await projectTask();
    configurePresets(store);
    const result = (await tabs.injectGuide({
      config: { provider: "codex/first" },
      workspaceId: "ws",
    } as never)) as { config: { systemPrompt?: string } };
    const prompt = result.config.systemPrompt ?? "";
    expect(prompt).toContain("你的身份：#2 会话");
    expect(prompt).toContain("#3 探路");
    expect(prompt).toContain("#4 执行");
    expect(prompt).toContain("#5 复核");
    expect(prompt).toContain("#6 验证");
    expect(prompt).toContain("send_agent_prompt");
    expect(prompt).toContain("get_agent_activity");
  });

  it("/执行 复用预建的执行 tab，并把确认快照冻结为该 tab 的模型", async () => {
    const { db, store, fake, flow } = await projectTask();
    const presets = configurePresets(store);
    await flow.provisionTabs("ws");
    const worker = store.tasks.get("ws")!.tabs.find((tab) => tab.role === "worker")!;
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
            model: "second",
          },
        });
      },
    });
    responder.start();
    try {
      const result = await flow.execute({
        workspaceId: "ws",
        agentId: "agent-1",
        requestId: "r-reuse",
      });
      expect(result.task.rolesSnapshot?.worker.models[0]).toMatchObject({
        provider: "codex",
        model: "second",
      });
      const queued = store.tasks.get("ws")!;
      const admission = {
        workspaceId: "ws",
        confirmedAt: queued.confirmedAt!,
        role: "worker" as const,
        reservationId: "res-1",
        presetId: presets.worker.id,
        provider: "codex",
        model: "second",
        port: 17123,
        deviceIds: [],
      };
      flow.resources.handleAdmission({
        type: "scheduler.task_admitted",
        payload: admission,
      } as never);
      await flow.workerAdmitted(admission);
      expect(fake.created).toHaveLength(4);
      expect(fake.sends.at(-1)?.agentId).toBe(worker.agentId);
      expect(fake.sends.at(-1)?.text).toContain("整理文档");
      const executing = store.tasks.get("ws")!;
      expect(executing.phase).toBe("executing");
      expect(executing.tabs.filter((tab) => tab.role === "worker")).toHaveLength(1);
    } finally {
      await responder.stop();
    }
  });

  it("用户直接在预建执行 tab 发消息时确认方案并补做准入", async () => {
    const { db, store, fake, flow } = await projectTask();
    configurePresets(store);
    await flow.provisionTabs("ws");
    const worker = store.tasks.get("ws")!.tabs.find((tab) => tab.role === "worker")!;
    fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("直接执行"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
    fake.setTimeline(worker.agentId, [
      {
        item: { type: "user_message", text: "直接开始，按方案做", messageId: "u-1" },
        turnId: "direct-1",
        seqEnd: 1,
      },
    ]);
    const responder = createEventConsumer({
      db,
      consumer: "test-direct-resources",
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
            reservationId: "res-direct",
            provider: "codex",
            model: "second",
          },
        });
      },
    });
    responder.start();
    try {
      await flow.turnStarted({
        agent: { id: worker.agentId, workspaceId: "ws" },
        turnId: "direct-1",
      });
      const task = store.tasks.get("ws")!;
      expect(task.confirmedAt).toBeTruthy();
      expect(task.phase).toBe("executing");
      expect(task.summary).toContain("直接授权");
      expect(fake.sends.at(-1)?.agentId).toBe(worker.agentId);
      expect(fake.sends.at(-1)?.text).toContain("直接执行");
    } finally {
      await responder.stop();
    }
  });
});

describe("状态行与流程面板", () => {
  it("每条用户触发的状态用唯一 id；相同文本 30 秒内只追加一次，过期或遗忘后可再追加", async () => {
    let clock = 1_000_000;
    const context = setup({ now: () => clock });
    context.fake.addAgent({ id: "agent-1" });
    await context.tabs.ensureTab("agent-1");
    const { fake, flow, tabs } = context;
    await flow.status({ workspaceId: "ws", agentId: "agent-1" });
    await flow.status({ workspaceId: "ws", agentId: "agent-1" });
    expect(fake.appended).toHaveLength(1);
    await tabs.appendStatus("agent-1", "不同的状态");
    expect(fake.appended).toHaveLength(2);
    const ids = fake.appended.map((entry) => (entry.item as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^task-status:/);
    expect(ids).not.toContain("task-status:agent-1");
    expect(fake.appended[0]!.item).toMatchObject({ kind: "task-status" });
    await tabs.appendStatus("agent-1", "不同的状态");
    expect(fake.appended).toHaveLength(2);
    clock += 30_000;
    await tabs.appendStatus("agent-1", "不同的状态");
    expect(fake.appended).toHaveLength(3);
    tabs.forgetStatus(["agent-1"]);
    await tabs.appendStatus("agent-1", "不同的状态");
    expect(fake.appended).toHaveLength(4);
  });

  it("面板返回阶段、tab 与可展开的探路和验证结论", async () => {
    const { store, fake, tabs, flow } = await projectTask();
    fake.addAgent({ id: "scout-agent", model: "first" });
    await tabs.ensureTab("scout-agent", { role: "scout" });
    fake.setTimeline("scout-agent", [
      {
        item: { type: "assistant_message", text: "探路结论：先改 service。", messageId: "s-1" },
        turnId: "scout-turn",
        seqEnd: 2,
      },
    ]);
    await flow.turnEnded({
      agent: { id: "scout-agent", workspaceId: "ws" },
      turnId: "scout-turn",
      outcome: { kind: "completed" },
    });
    store.taskArtifacts.record({
      workspaceId: "ws",
      kind: "verification",
      sourceKey: "verify-panel",
      confirmedAt: null,
      source: { tabNumber: 1, agentId: "agent-1", sourceKey: "verify-panel" },
      summary: "验证通过",
      data: { conclusion: "pass" },
    });
    const view = await flow.panel("ws");
    expect(view.isTask).toBe(true);
    expect(view.tabs.find((tab) => tab.number === 2)).toMatchObject({
      role: "scout",
      roleLabel: "探路",
    });
    expect(view.steps.map((step) => step.kind)).toEqual(["scout", "verification"]);
    expect(view.steps[0]!.summary).toContain("探路结论");
    expect(view.steps[0]!.detail).toContain("先改 service");
    expect(view.steps[1]!.summary).toBe("验证通过");
  });
});

/** Answers every scheduler request with success and records the actions in order. */
function startScheduler(db: VibeDb, reservationId = "res-1") {
  const actions: string[] = [];
  const responder = createEventConsumer({
    db,
    consumer: "test-scheduler-" + reservationId,
    types: ["scheduler.task_resource_request"],
    pollIntervalMs: 2,
    startAt: "now",
    handler: (event) => {
      const payload = event.payload as { requestId: string; workspaceId: string; action: string };
      actions.push(payload.action);
      publishEvent(db, {
        type: "scheduler.task_resource_result",
        payload: {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          ok: true,
          reason: "",
          reservationId,
          provider: "codex",
          model: "second",
        },
      });
    },
  });
  responder.start();
  return { actions, stop: () => responder.stop() };
}

/** A task with pre-created role tabs whose #1 holds a complete plan. */
async function provisionedTask(options: { plan?: boolean } = {}) {
  const context = await projectTask();
  const presets = configurePresets(context.store);
  await context.flow.provisionTabs("ws");
  if (options.plan !== false)
    context.fake.setTimeline("agent-1", [
      {
        item: { type: "assistant_message", text: planMessage("整理文档"), messageId: "m-1" },
        turnId: "turn-1",
        seqEnd: 3,
      },
    ]);
  const worker = context.store.tasks.get("ws")!.tabs.find((tab) => tab.role === "worker")!;
  return { ...context, presets, worker };
}

function admissionFor(
  store: ReturnType<typeof createVibeStore>,
  presetId: string,
  reservationId = "res-1",
) {
  return {
    workspaceId: "ws",
    confirmedAt: store.tasks.get("ws")!.confirmedAt!,
    role: "worker" as const,
    reservationId,
    presetId,
    provider: "codex",
    model: "second",
    port: 17123,
    deviceIds: [],
  };
}

/** The user typed `text` in the execution tab; its turn is running. */
function userTurn(
  fake: ReturnType<typeof fakePaseo>,
  agentId: string,
  turnId: string,
  text: string,
) {
  fake.setTimeline(agentId, [
    { item: { type: "user_message", text, messageId: "u-" + turnId }, turnId, seqEnd: 1 },
  ]);
  const agent = fake.agents.get(agentId)!;
  agent.status = "running";
  agent.activeTurn = { id: turnId };
}

describe("执行 tab 直接授权与调度准入", () => {
  it("/执行 排队后准入先到、用户消息正在运行：两条路径只执行一次，不释放对方租约", async () => {
    const { db, store, fake, flow, presets, worker } = await provisionedTask();
    const scheduler = startScheduler(db);
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      expect(store.tasks.get("ws")!.phase).toBe("queued");
      const admission = admissionFor(store, presets.worker.id);
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      userTurn(fake, worker.agentId, "direct-1", "开始执行吧");
      const sendsBefore = fake.sends.length;
      await Promise.all([
        flow.workerAdmitted(admission),
        flow.turnStarted({ agent: { id: worker.agentId, workspaceId: "ws" }, turnId: "direct-1" }),
      ]);
      const task = store.tasks.get("ws")!;
      expect(task.phase).toBe("executing");
      expect(task.control?.blockingReason ?? null).toBeNull();
      expect(fake.sends.slice(sendsBefore).filter((send) => send.agentId === worker.agentId)).toHaveLength(1);
      expect(scheduler.actions).not.toContain("release");
      expect(scheduler.actions.filter((action) => action === "bind")).toHaveLength(1);
      expect(flow.resources.holderOf("res-1")).toBe(worker.agentId);
      expect(fake.operations).not.toContain("cancel:" + worker.agentId);
    } finally {
      await scheduler.stop();
    }
  });

  it("/执行 排队后用户消息先完成授权、准入事件后到：准入路径直接返回，不释放", async () => {
    const { db, store, fake, flow, presets, worker } = await provisionedTask();
    const scheduler = startScheduler(db);
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      const admission = admissionFor(store, presets.worker.id);
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      userTurn(fake, worker.agentId, "direct-1", "开始执行吧");
      const sendsBefore = fake.sends.length;
      await flow.turnStarted({ agent: { id: worker.agentId, workspaceId: "ws" }, turnId: "direct-1" });
      await flow.workerAdmitted(admission);
      expect(store.tasks.get("ws")!.phase).toBe("executing");
      expect(fake.sends.slice(sendsBefore)).toHaveLength(1);
      expect(scheduler.actions).not.toContain("release");
      expect(scheduler.actions.filter((action) => action === "bind")).toHaveLength(1);
      expect(flow.resources.holderOf("res-1")).toBe(worker.agentId);
    } finally {
      await scheduler.stop();
    }
  });

  it("准入时执行 tab 正被 agent 消息占用：保留准入，回合结束后自动发送执行确认", async () => {
    const { db, store, fake, flow, presets, worker } = await provisionedTask();
    const scheduler = startScheduler(db);
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      const admission = admissionFor(store, presets.worker.id);
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      const agent = fake.agents.get(worker.agentId)!;
      agent.status = "running";
      agent.activeTurn = { id: "agent-turn" };
      await flow.workerAdmitted(admission);
      expect(store.tasks.get("ws")!.phase).toBe("queued");
      expect(scheduler.actions).not.toContain("release");
      agent.status = "idle";
      agent.activeTurn = null;
      await flow.turnEnded({
        agent: { id: worker.agentId, workspaceId: "ws" },
        turnId: "agent-turn",
        outcome: { kind: "completed" },
      });
      expect(store.tasks.get("ws")!.phase).toBe("executing");
      expect(fake.sends.at(-1)).toMatchObject({ agentId: worker.agentId });
      expect(fake.sends.at(-1)!.text).toContain("整理文档");
      expect(scheduler.actions).not.toContain("release");
    } finally {
      await scheduler.stop();
    }
  });

  it("执行中且执行 tab 已持有租约时，用户追问不重复准入、不发送、不取消", async () => {
    const { db, store, fake, flow, presets, worker } = await provisionedTask();
    const scheduler = startScheduler(db);
    try {
      await flow.execute({ workspaceId: "ws", agentId: "agent-1", requestId: "r-1" });
      const admission = admissionFor(store, presets.worker.id);
      flow.resources.handleAdmission({ type: "scheduler.task_admitted", payload: admission } as never);
      await flow.workerAdmitted(admission);
      expect(store.tasks.get("ws")!.phase).toBe("executing");
      const actions = scheduler.actions.length;
      const sends = fake.sends.length;
      userTurn(fake, worker.agentId, "follow-up", "进度怎么样了？");
      await flow.turnStarted({ agent: { id: worker.agentId, workspaceId: "ws" }, turnId: "follow-up" });
      expect(scheduler.actions.length).toBe(actions);
      expect(fake.sends.length).toBe(sends);
      expect(fake.operations).not.toContain("cancel:" + worker.agentId);
      expect(flow.resources.hasLease(worker.agentId)).toBe(true);
    } finally {
      await scheduler.stop();
    }
  });

  it("规划阶段没有完整方案时，执行 tab 的用户消息就是任务说明：确认、准入并记录无方案", async () => {
    const { db, store, fake, flow, worker } = await provisionedTask({ plan: false });
    const scheduler = startScheduler(db, "res-direct");
    try {
      userTurn(fake, worker.agentId, "direct-1", "把 README 的标题改成 Vibe");
      await flow.turnStarted({ agent: { id: worker.agentId, workspaceId: "ws" }, turnId: "direct-1" });
      const task = store.tasks.get("ws")!;
      expect(task.confirmedAt).toBeTruthy();
      expect(task.phase).toBe("executing");
      expect(task.plan?.goal).toBe("把 README 的标题改成 Vibe");
      expect(task.plan?.approach).toContain("无方案，按用户在执行 tab 的指示执行");
      expect(task.control?.directInstruction).toBe(true);
      expect(task.summary).toContain("无方案");
      expect(scheduler.actions).toEqual(expect.arrayContaining(["acquire", "bind"]));
      expect(fake.sends.at(-1)).toMatchObject({ agentId: worker.agentId });
      expect(fake.sends.at(-1)!.text).toContain("无方案，按用户在执行 tab 的指示执行");
      expect(fake.sends.at(-1)!.text).toContain("只是提问");
      expect(fake.operations).not.toContain("cancel:" + worker.agentId);
      const status = await flow.status({ workspaceId: "ws", agentId: worker.agentId });
      expect(status.text).toContain("执行依据：无方案");
    } finally {
      await scheduler.stop();
    }
  });

  it("回合没有 turnId 时不认定任何用户消息为授权", async () => {
    const { db, store, fake, flow, worker } = await provisionedTask();
    const scheduler = startScheduler(db);
    try {
      userTurn(fake, worker.agentId, "direct-1", "开始执行吧");
      await flow.turnStarted({ agent: { id: worker.agentId, workspaceId: "ws" }, turnId: null });
      expect(store.tasks.get("ws")!.confirmedAt).toBeNull();
      expect(scheduler.actions).toHaveLength(0);
      expect(fake.sends.filter((send) => send.agentId === worker.agentId)).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("预建执行 tab 的提示词要求收到执行确认前不改文件，且清单以 vibe_tabs 为准", async () => {
    const { store, tabs } = await projectTask();
    configurePresets(store);
    const result = (await tabs.injectGuide({
      config: { provider: "codex/second" },
      env: { VIBE_ROLE: "worker" },
      workspaceId: "ws",
    } as never)) as { config: { systemPrompt?: string } };
    const prompt = result.config.systemPrompt ?? "";
    expect(prompt).toContain("执行确认");
    expect(prompt).toContain("之前不要修改任何文件");
    expect(prompt).toContain("以 vibe_tabs 的实时结果为准");
    expect(prompt).toContain("没有方案时这条消息就是任务说明");
  });
});

describe("预建 tab 的边界", () => {
  it("登记失败的预建 agent 下次先补登记，仍失败则归档，不重复创建", async () => {
    const { store, fake, flow } = await projectTask();
    configurePresets(store);
    fake.setCreatePatch({ internal: true });
    await flow.provisionTabs("ws");
    expect(fake.created).toHaveLength(4);
    expect(store.tasks.get("ws")!.tabs).toHaveLength(1);
    fake.setCreatePatch({});
    fake.agents.get("worker-1")!.internal = false;
    await flow.provisionTabs("ws");
    expect(fake.created).toHaveLength(4);
    expect(store.tasks.get("ws")!.tabs.map((tab) => [tab.agentId, tab.role])).toEqual([
      ["agent-1", "main"],
      ["worker-1", "scout"],
    ]);
    expect(fake.operations).toEqual(
      expect.arrayContaining(["archive:worker-2", "archive:worker-3", "archive:worker-4"]),
    );
    expect(fake.operations).not.toContain("archive:worker-1");
    await flow.provisionTabs("ws");
    expect(fake.created).toHaveLength(7);
    expect(store.tasks.get("ws")!.tabs.map((tab) => tab.role)).toEqual([
      "main",
      "scout",
      "worker",
      "reviewer",
      "verifier",
    ]);
  });

  it("暂停的任务不补建 tab；面板与 /状态 只读，不补建", async () => {
    const { store, fake, flow } = await projectTask();
    configurePresets(store);
    await flow.panel("ws");
    await flow.status({ workspaceId: "ws", agentId: "agent-1" });
    await Promise.resolve();
    expect(fake.created).toHaveLength(0);
    store.tasks.setPhase("ws", "paused");
    await flow.provisionTabs("ws");
    expect(fake.created).toHaveLength(0);
  });

  it("预建复核/验证 tab 与按需打开时使用同一权限模式", async () => {
    const { store, fake, flow } = await projectTask();
    configurePresets(store);
    await flow.provisionTabs("ws");
    const byRole = (role: string) =>
      fake.created.find((input) => (input.env as Record<string, string>).VIBE_ROLE === role)!
        .config as { modeId?: string };
    expect(byRole("reviewer").modeId).toBe("auto");
    expect(byRole("worker").modeId).toBe("full-access");
    expect(byRole("scout").modeId).toBeUndefined();
  });

  it("面板 RPC 拒绝 agent 调用", async () => {
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
      const panel = handlers.get("vibe.task.panel")!;
      await expect(
        panel({ workspaceId: "ws" }, { callerAgentId: "agent-2", paseo: fake.paseo }),
      ).rejects.toThrow("agent 消息不能授权任务命令");
      const view = (await panel({ workspaceId: "ws" }, { paseo: fake.paseo })) as {
        isTask: boolean;
      };
      expect(view.isTask).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
