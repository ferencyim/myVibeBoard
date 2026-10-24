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
import { TASK_TAB_ROLE_LABEL, TASK_TAB_PRESET_LABEL } from "../server/vibe/contract";

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

function setup() {
  const db = openVibeDb({ path: ":memory:" });
  handles.push(db);
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  const fake = fakePaseo();
  const tabs = createTaskTabs({ store, getPaseo: () => fake.paseo as never });
  const flow = createTaskFlow({
    db,
    store,
    tabs,
    getPaseo: () => fake.paseo as never,
    log: () => {},
  });
  flow.registerPrompts();
  return { db, store, fake, tabs, flow };
}

function planMessage(goal = "完成目标") {
  return [
    "方案如下：",
    "```vibe-plan",
    JSON.stringify({
      goal,
      approach: "按步骤实现",
      files: ["src/**"],
      subtasks: [],
      checks: [{ text: "测试通过", method: "运行单测" }],
    }),
    "```",
  ].join("\n");
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

  it("带角色标签的 agent 使用对应角色标签，且不改写已有编号", async () => {
    const { store, fake, tabs } = setup();
    fake.addAgent({ id: "agent-1" });
    await tabs.ensureTab("agent-1");
    fake.addAgent({ id: "scout-1", labels: { [TASK_TAB_ROLE_LABEL]: "scout" } });
    const scout = await tabs.ensureTab("scout-1");
    expect(scout).toMatchObject({ number: 2, role: "scout" });
    expect(fake.titles.at(-1)?.title).toBe("#2 探路 · first");
    fake.agents.get("scout-1")!.labels = { [TASK_TAB_ROLE_LABEL]: "worker" };
    expect((await tabs.ensureTab("scout-1"))?.number).toBe(2);
    expect(store.tasks.get("ws")!.tabs[1]!.role).toBe("scout");
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

describe("命令授权", () => {
  it("拒绝 agent 发起的执行/通过/状态命令，用户调用仍可用", async () => {
    const db = openVibeDb({ path: ":memory:" });
    handles.push(db);
    migrateOwner(db, "core");
    const store = createVibeStore(db);
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
