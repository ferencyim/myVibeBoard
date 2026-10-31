import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { listHostProjects } from "./host-data";
import { EVENT_PAYLOADS } from "./vibe/contract";
import {
  createEventConsumer,
  createTaskRuntimeCommands,
  type VibeDb,
  type VibeStore,
} from "./vibe/db";
import { createTaskTabs } from "./tabs/service";
import { createTaskFlow } from "./tabs/flow";
import { createTaskBoard } from "./tabs/board";
import { createCoordination } from "./tabs/coordination";
import { createGroupChat } from "./tabs/group-chat";
import {
  groupSelectRpc,
  groupTargetsRpc,
  taskPanelRpc,
  taskFlowSetRpc,
  taskPlanStartRpc,
  taskWorkspaceTabsRpc,
  taskTabCommandRpc,
  taskTabEnsureRpc,
} from "../shared/task-tabs";

const AGENT_CALLER_ERROR = "agent 消息不能授权任务命令；请由用户在原生输入框发送斜杠命令或「通过」";

/** The business owner for numbered task tabs and the open-tab task flow. */
export function registerTaskRuntime(
  server: PluginServerContext,
  options: {
    promptsReady?: Promise<void>;
    db: VibeDb;
    store: VibeStore;
    getPaseo(): PaseoApi | null;
    onPaseo(paseo: PaseoApi): void;
    /** Plan reviewer timeout from the owner settings. */
    reviewTimeoutMs?: () => number;
  },
) {
  const log = (message: string, error?: unknown) =>
    console.error("[vibe-board] " + message, error ?? "");
  let closed = false;
  const runtime = createTaskRuntimeCommands(options.db);
  const tabs = createTaskTabs({
    store: options.store,
    getPaseo: options.getPaseo,
    sessions: runtime,
    log,
  });
  const groupChat = createGroupChat({
    store: options.store,
    tabs,
    getPaseo: options.getPaseo,
    log,
    ensureRoleTab: (input) => flow.ensureRoleTab(input),
  });
  const flow = createTaskFlow({
    db: options.db,
    store: options.store,
    tabs,
    getPaseo: options.getPaseo,
    progress: groupChat,
    log,
    ...(options.reviewTimeoutMs ? { reviewTimeoutMs: options.reviewTimeoutMs } : {}),
  });
  if (!options.promptsReady) flow.registerPrompts();
  const board = createTaskBoard({
    store: options.store,
    getPaseo: options.getPaseo,
    directory: async (workspaceId) => {
      const placement = await tabs.workspace(workspaceId);
      if (!placement.directory) throw new Error("找不到任务工作区目录");
      return placement.directory;
    },
    appendStatus: tabs.appendStatus,
    report: groupChat.report,
    log,
  });
  const coordination = createCoordination({
    store: options.store,
    tabs,
    getPaseo: options.getPaseo,
    log,
  });
  const cleanups = [
    server.before("workspace.create", ({ request }) => {
      tabs.trackWorkspaceCreate(request);
    }),
    server.on("workspace.created", ({ workspace }, context) => {
      options.onPaseo(context.paseo);
      tabs.claimCreatedWorkspace(workspace.id);
    }),
    server.before("agent.create", async ({ request }, context) => {
      options.onPaseo(context.paseo);
      if (request.workspaceId) {
        try {
          const placement = await tabs.workspace(request.workspaceId);
          if (placement.projectId) {
            const projects = await listHostProjects(context.paseo);
            if (!projects.projects.some((project) => project.projectId === placement.projectId))
              await listHostProjects(context.paseo, true);
          }
        } catch (error) {
          log("任务项目扩展关联失败", error);
        }
      }
      // A sub-agent of the execution tab must be bound to a claimed board subtask.
      const brief = await board.guardCreate(request);
      const next = await tabs.injectGuide(request);
      if (!brief) return next;
      return {
        ...next,
        config: {
          ...next.config,
          systemPrompt: [next.config.systemPrompt, brief].filter(Boolean).join("\n\n"),
        },
      };
    }),
    server.on("agent.created", async ({ agent }, context) => {
      options.onPaseo(context.paseo);
      if (closed) return;
      await board.agentCreated(agent).catch((error) => log("子代理认领移交失败", error));
      await tabs.ensureTab(agent.id).catch((error) => log("任务 tab 登记失败", error));
      const task = agent.workspaceId ? options.store.tasks.get(agent.workspaceId) : undefined;
      if (task && task.anchorAgentId === agent.id && task.tabs.length === 1)
        void flow
          .provisionTabs(task.workspaceId)
          .then(() => flow.notifyFlowDecided(task.workspaceId, undefined, true))
          .catch((error) => log("流程 tab 预建失败", error));
    }),
    // Closed or archived tabs no longer need status repeat suppression; a closed or archived plan
    // reviewer fails its review slot.
    server.on("agent.closed", async ({ agent }) => {
      tabs.forgetStatus([agent.id]);
      await flow
        .reviewerGone(agent, "closed")
        .catch((error) => log("方案审阅者关闭处理失败", error));
    }),
    server.on("agent.archived", async ({ agent }) => {
      tabs.forgetStatus([agent.id]);
      await flow
        .reviewerGone(agent, "archived")
        .catch((error) => log("方案审阅者归档处理失败", error));
    }),
    server.on("workspace.archived", ({ workspace }) => {
      const task = options.store.tasks.get(workspace.id);
      if (task) tabs.forgetStatus(task.tabs.map((tab) => tab.agentId));
      try {
        coordination.markArchived(workspace.id);
      } catch (error) {
        log("任务归档标记失败", error);
      }
    }),
    server.on("agent.turn_started", async ({ agent, turnId }, context) => {
      options.onPaseo(context.paseo);
      if (closed) return;
      groupChat.anchorTurn(agent, true);
      try {
        await flow.turnStarted({ agent, turnId });
      } catch (error) {
        log("任务 tab 回合开始处理失败", error);
      }
    }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, context) => {
      options.onPaseo(context.paseo);
      if (closed) return;
      groupChat.anchorTurn(agent, false);
      try {
        await flow.turnEnded({ agent, turnId, outcome });
      } catch (error) {
        log("任务 tab 回合收尾失败", error);
      }
    }),
    server.on("agent.permission_requested", async ({ agent }, context) => {
      options.onPaseo(context.paseo);
      if (closed) return;
      await groupChat.permissionRequested(agent).catch((error) => log("#1 审批提示失败", error));
    }),
  ];
  // Hosts without the agent.prompt hook still enforce claims at create_agent and claim time.
  try {
    cleanups.push(
      server.before("agent.prompt", async ({ request }, context) => {
        options.onPaseo(context.paseo);
        await board.guardPrompt(request);
      }),
    );
  } catch (error) {
    log("宿主不支持 agent.prompt 钩子，send_agent_prompt 派发不做看板检查", error);
  }
  try {
    cleanups.push(
      server.before("agent.permission_response", async ({ request }, context) => {
        options.onPaseo(context.paseo);
        await board.guardPermissionResponse(request);
      }),
    );
  } catch (error) {
    log("宿主不支持 agent.permission_response 钩子，任务 agent 仍可代答审批", error);
  }
  // #1 group chat: `@#n` and the「发给」target route a person's message to another tab. Hosts
  // without the hook keep #1 as an ordinary chat.
  try {
    cleanups.push(
      // Decide and queue only: the host waits on this hook, and the forward runs after the
      // host recorded the takeover (agent.user_prompt_handled).
      server.before("agent.user_prompt", ({ request }, context) => {
        options.onPaseo(context.paseo);
        if (closed || !request.workspaceId) return;
        return groupChat.userPrompt(request);
      }),
      server.on("agent.user_prompt_handled", (event) => {
        if (!closed) groupChat.userPromptHandled(event);
      }),
    );
  } catch (error) {
    log("宿主不支持 agent.user_prompt 钩子，#1 不能用 @#n 直接转给其它 tab", error);
  }
  server.handle(taskTabEnsureRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    return flow.ensureRoleTab(input);
  });
  const suggestionInput = z.object({
    level: z.enum(["medium", "full"]),
    reason: z.string().trim().min(1),
  }).strict();
  server.registerAgentTool({
    name: "vibe_suggest_flow",
    description: "建议用户升高当前任务流程档位，并说明理由；建议发送到 #1，由用户确认后生效。",
    input: suggestionInput,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("只有任务 tab 可以建议升档");
      const paseo = options.getPaseo();
      if (!paseo) throw new Error("任务宿主连接尚未就绪");
      const handle = paseo.agents.ref(callerAgentId);
      await handle.refresh();
      const agent = handle.current();
      const task = agent?.workspaceId ? options.store.tasks.get(agent.workspaceId) : undefined;
      if (!task || !task.tabs.some((tab) => tab.agentId === callerAgentId))
        throw new Error("只有任务 tab 可以建议升档");
      const suggestion = suggestionInput.parse(input);
      const ranks = { simple: 0, medium: 1, full: 2 } as const;
      if (ranks[suggestion.level] <= ranks[task.flowLevel ?? "full"])
        throw new Error("建议的档位必须高于当前档位");
      await tabs.appendStatus(task.anchorAgentId, `建议将流程升为${suggestion.level === "medium" ? "中等" : "完整"}：${suggestion.reason}。请用户在流程面板确认。`);
      return { sent: true };
    },
  });
  server.handle(groupTargetsRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    return groupChat.targetsFor(input.workspaceId, input.agentId);
  });
  server.handle(groupSelectRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    return groupChat.select(input.workspaceId, input.agentId, input.number);
  });
  server.handle(taskWorkspaceTabsRpc, (input, context) => {
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    const task = options.store.tasks.get(input.workspaceId);
    return task ? tabs.tabsFor(task, false) : [];
  });
  server.handle(taskFlowSetRpc, async (input, context) => {
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    options.store.tasks.setFlow(input.workspaceId, { level: input.level, source: "user", reason: "用户调整流程" });
    await flow.provisionTabs(input.workspaceId);
    await flow.notifyFlowDecided(input.workspaceId, undefined, true);
    return { task: options.store.tasks.get(input.workspaceId)! };
  });
  server.handle(taskPlanStartRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    return flow.startPlanner(input.workspaceId);
  });
  server.handle(taskPanelRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    const view = await flow.panel(input.workspaceId);
    return {
      ...view,
      board: view.task ? board.panel(view.task) : [],
      otherPlans: view.task ? await coordination.panelPlans(input.workspaceId) : [],
    };
  });
  server.handle(taskTabCommandRpc, async (input, context) => {
    options.onPaseo(context.paseo);
    if (context.callerAgentId) throw new Error(AGENT_CALLER_ERROR);
    if (input.action === "execute") {
      const result = await flow.execute(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "accept") {
      const result = await flow.accept(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "stop") {
      const result = await flow.stop(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "rereview") {
      const result = await flow.rereview(input);
      return { task: result.task, message: result.message };
    }
    if (input.action === "handoff") {
      const result = await flow.handoff(input);
      return { task: result.task, message: result.message };
    }
    const result = await flow.status(input);
    return { task: result.task, message: result.text };
  });
  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-board:task-tabs",
    types: ["scheduler.task_admitted", "context.continuation_requested"],
    handler: async (event) => {
      await options.promptsReady;
      if (!options.getPaseo()) throw new Error("任务宿主连接尚未就绪，保留事件待重试");
      if (event.type === "context.continuation_requested") {
        const payload = EVENT_PAYLOADS["context.continuation_requested"].parse(event.payload);
        if (!payload.workspaceId) return;
        await flow.continuation({ ...payload, workspaceId: payload.workspaceId });
        return;
      }
      flow.resources.handleAdmission(event);
      if (event.type !== "scheduler.task_admitted") return;
      await flow.workerAdmitted(EVENT_PAYLOADS["scheduler.task_admitted"].parse(event.payload));
    },
    onError: (error) => log("任务准入或接续事件处理失败", error),
  });
  consumer.start();
  const progress = createEventConsumer({
    db: options.db,
    consumer: "vibe-board:group-chat",
    types: ["task.updated"],
    startAt: "now",
    handler: async (event) => {
      const payload = EVENT_PAYLOADS["task.updated"].parse(event.payload);
      await groupChat.taskUpdated(payload.workspaceId, payload.fields);
    },
    onError: (error) => log("#1 阶段汇报失败", error),
  });
  progress.start();
  // Review cycles survive plugin restarts: settle them shortly after start, then sweep for
  // timeouts and missed events once a minute.
  const recover = () =>
    void Promise.resolve(options.promptsReady)
      .then(() => {
        if (closed) return;
        return Promise.all([flow.recoverReviews(), flow.provisionMissing()]);
      })
      .catch((error) => log("方案审阅恢复失败", error));
  const startRecovery = setTimeout(recover, 5_000);
  const sweep = setInterval(recover, 60_000);
  return {
    flow,
    tabs,
    board,
    coordination,
    groupChat,
    async close() {
      closed = true;
      clearTimeout(startRecovery);
      clearInterval(sweep);
      for (const cleanup of cleanups) cleanup();
      await consumer.stop();
      await progress.stop();
      groupChat.close();
      await flow.close();
    },
  };
}
