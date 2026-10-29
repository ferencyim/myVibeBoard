import { listHostProjects } from "./server/host-data";
import { readLegacyMaintenance } from "./server/project-agent/settings-migration";
import { createProjectAgents } from "./server/project-agent/service";
import { registerProjectAgents } from "./server/project-agent/register";
import { registerProjectConfigTool } from "./server/project-agent/config";
import { createProjectDocuments, registerProjectDocumentRpcs } from "./server/project-documents";
import { registerEnvironmentMonitor } from "./server/environment";
import { createProjectCompletion } from "./server/project-agent/completion";
import { deferStartup } from "./server/vibe/db/startup";
import { registerResourceTool } from "./server/resource-tool";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { createBoardService, openBoardRuntime } from "./server/service";
import { registerBoardRpcs } from "./server/rpc";
import { verifyEvidenceRpc } from "./shared/evidence";
import { createTaskEvidenceReader } from "./server/evidence";
import { registerTaskRuntime } from "./server/task-runtime";
import { registerBoardTools } from "./server/tabs/board-tools";
import { boardSettings, type BoardSettingsValues } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const runtime = openBoardRuntime();
  const startup = deferStartup(
    () => tasks.flow.registerPrompts(),
    (error) => console.error("[vibe-board] 后台提示词初始化失败", error),
  );
  // Requests may arrive as soon as ready is sent; wait for the same startup promise.
  const host = server;
  server = {
    ...host,
    handle: (rpc, handler) => host.handle(rpc, startup.wrap(handler)),
    before: (name, handler) => host.before(name, startup.wrap(handler)),
    on: (name, handler) => host.on(name, startup.wrap(handler)),
    registerAgentTool: (tool) =>
      host.registerAgentTool({ ...tool, handler: startup.wrap(tool.handler) }),
  };

  let paseo: PaseoApi | null = server.paseo ?? null;
  // Owner settings, read on every use.
  const settings = server.registerSettings({
    ...boardSettings,
    schema: z.preprocess(readLegacyMaintenance, boardSettings.schema),
    migrate: readLegacyMaintenance,
  });
  let preferences: BoardSettingsValues = boardSettings.schema.parse({});
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") preferences = boardSettings.schema.parse(state.values);
  };
  void settings.read().then(applySettings, () => {});
  const stopSettings = settings.subscribe(applySettings);
  const tasks = registerTaskRuntime(server, {
    reviewTimeoutMs: () => preferences.planReviewTimeoutMinutes * 60_000,
    promptsReady: startup.ready,
    db: runtime.db,
    store: runtime.store,
    getPaseo: () => paseo,
    onPaseo: (api) => {
      paseo = api;
      environment.observe(api);
    },
  });
  const projects = createProjectAgents({
    db: runtime.db,
    store: runtime.store,
    getPaseo: () => paseo,
    tabs: tasks.tabs,
    flow: tasks.flow,
  });
  const stopProjects = registerProjectAgents(server, projects);
  registerProjectConfigTool(server, projects);
  const documents = createProjectDocuments({
    db: runtime.db,
    listProjects: async () => {
      if (!paseo) throw new Error("项目宿主尚未连接");
      return (await listHostProjects(paseo)).projects;
    },
    notifyMerge: projects.sendProject,
  });
  registerProjectDocumentRpcs(server, documents, projects.callerProject);
  void startup.ready
    .then(() => documents.start())
    .catch((error) => console.error("[vibe-board] 项目文档同步失败", error));
  const environment = registerEnvironmentMonitor(server, {
    store: runtime.store,
    projects,
    getPaseo: () => paseo,
    tasks,
  });
  if (paseo) environment.observe(paseo);
  const completion = createProjectCompletion({
    db: runtime.db,
    store: runtime.store,
    getPaseo: () => paseo,
    settings: () => preferences,
    sendProject: projects.sendProject,
    ready: startup.ready,
  });
  registerBoardRpcs(server, createBoardService(runtime), () => paseo);
  const evidence = createTaskEvidenceReader(runtime.db);
  server.handle(verifyEvidenceRpc, (input) => evidence.evidence(input.evidenceId, input.thumb));
  server.registerAgentTool({
    name: "vibe_tabs",
    description:
      "读取当前 Vibe 任务 tab 的编号、角色、模型和状态。任何任务 tab 都可调用；用户说「继续 #n 的工作」时先用它确认 #n。",
    handler: async (_input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("vibe_tabs 只能由任务 tab 调用");
      return tasks.tabs.vibeTabs(callerAgentId);
    },
  });
  registerResourceTool(server, runtime.db);
  const openTabInput = z
    .object({
      role: z.enum(["scout", "plan_reviewer", "session"]),
      task: z.string().trim().min(1).describe("交给新 tab 的任务说明"),
      provider: z.string().trim().optional().describe("provider/model；省略时沿用当前 tab 的模型"),
      presetId: z.string().trim().optional(),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_open_tab",
    description:
      "由插件在当前 Vibe 任务中打开一个新的编号 tab（scout 按角色提示词保持只读）。需要额外的并行探路时使用它，不要用 create_agent 冒充任务 tab；方案审阅由插件按 #2 的模型列表自动安排，不需要开 tab。",
    input: openTabInput,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("vibe_open_tab 只能由任务 tab 调用");
      return tasks.tabs.openTab(callerAgentId, openTabInput.parse(input));
    },
  });
  registerBoardTools(server, tasks.board);
  const askScoutInput = z
    .object({ question: z.string().trim().min(1).describe("要调查的问题，写清范围与想要的结论") })
    .strict();
  server.registerAgentTool({
    name: "vibe_ask_scout",
    description:
      "把调查问题投给本任务的探路 tab（附上你的 #编号）。探路完成后会用 send_agent_prompt 把结论发回给你；本任务未启用探路时返回错误。",
    input: askScoutInput,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("vibe_ask_scout 只能由任务 tab 或其子代理调用");
      return tasks.coordination.askScout(callerAgentId, askScoutInput.parse(input));
    },
  });
  const projectPlansInput = z
    .object({
      files: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("要检查重叠的文件或 glob；省略时用本任务当前（或审阅中的）方案文件"),
    })
    .strict();
  server.registerAgentTool({
    name: "vibe_project_plans",
    description:
      "列出同项目其它任务的方案状态（草稿、待确认、执行中、复核/验证中、待验收、已完成、已放弃）、目标、涉及文件和最近更新时间，并标出与本任务方案文件重叠的条目。#2 写方案前、#4 开始执行前先调用。",
    input: projectPlansInput,
    handler: async (input, { callerAgentId }) => {
      if (!callerAgentId) throw new Error("vibe_project_plans 只能由任务 tab 或其子代理调用");
      if (await projects.projectForAgent(callerAgentId)) return projects.tasksFor(callerAgentId);
      return tasks.coordination.projectPlansFor(callerAgentId, projectPlansInput.parse(input));
    },
  });
  return async () => {
    stopSettings();
    stopProjects();
    await completion.close();
    await environment.close();
    await documents.close();
    await startup.close();
    await tasks.close();
    runtime.close();
  };
}
