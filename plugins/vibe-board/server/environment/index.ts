import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { recentDaemonLog, relatedProcesses } from "./diagnostics";
import type { registerTaskRuntime } from "../task-runtime";
import {
  TASK_TAB_ROLE_LABEL,
  TASK_TAB_PRESET_LABEL,
  presetModels,
  TaskPresetSnapshotSchema,
} from "../vibe/contract";
import {
  createFailureWindow,
  diagnosticText,
  environmentFailure,
  timelineFailureText,
} from "./detection";
import type { VibeStore } from "../vibe/db";

interface ProjectAgents {
  projectForAgent(agentId: string): Promise<string | null>;
  callerProject(agentId: string): Promise<string>;
  sendProject(projectId: string, text: string): Promise<void>;
  appendStatus(agentId: string, text: string): Promise<void>;
  setError(projectId: string, error: string | null): void;
}
export function registerEnvironmentMonitor(
  server: PluginServerContext,
  options: {
    store: VibeStore;
    projects: ProjectAgents;
    getPaseo(): PaseoApi | null;
    tasks?: Pick<ReturnType<typeof registerTaskRuntime>, "tabs" | "flow">;
  },
) {
  const allowed = createFailureWindow();
  const errors: Array<{
    agentId: string;
    projectId: string;
    text: string;
    at: string;
    provider: string;
    model: string;
  }> = [];
  const api = () => {
    const paseo = options.getPaseo();
    if (!paseo) throw new Error("宿主尚未连接");
    return paseo;
  };
  async function placement(agentId: string) {
    const project = await options.projects.projectForAgent(agentId);
    if (project) return { projectId: project, own: true, label: "项目 agent" };
    const snapshot = await api().agents.ref(agentId).refresh();
    const workspaceId = snapshot?.agent.workspaceId;
    const task = workspaceId ? options.store.tasks.get(workspaceId) : undefined;
    const tab = task?.tabs.find((entry) => entry.agentId === agentId);
    if (!task || !tab || !workspaceId) return null;
    const workspace = await api().workspaces.ref(workspaceId).refresh();
    return workspace
      ? {
          projectId: workspace.projectId,
          own: false,
          label: (task.plan?.goal ?? workspaceId) + " #" + tab.number,
        }
      : null;
  }
  async function report(agentId: string, raw: string, startup = false) {
    const kind = environmentFailure(raw) ?? (startup ? "agent_start" : null);
    if (!kind) return;
    const target = await placement(agentId);
    if (!target || !allowed(agentId, kind)) return;
    const handle = api().agents.ref(agentId);
    await handle.refresh();
    const agent = handle.current();
    const error = {
      agentId,
      projectId: target.projectId,
      text: diagnosticText(raw),
      at: new Date().toISOString(),
      provider: agent?.provider ?? "",
      model: agent?.model ?? "",
    };
    errors.push(error);
    if (errors.length > 100) errors.shift();
    if (target.own) {
      options.projects.setError(target.projectId, error.text);
      await options.projects.appendStatus(agentId, "项目 agent 环境异常，请检查：" + error.text);
      return;
    }
    await options.projects.sendProject(
      target.projectId,
      "[环境故障诊断通知，非用户指令]\n" +
        JSON.stringify({ ...error, source: target.label, kind }) +
        "\n先调用 vibe_env_diagnose。可重试或重开 tab；修改系统设置、提权或终止他人进程必须交给用户决定。不得代替用户审批。",
    );
  }
  const log = (error: unknown) => console.error("[vibe-board] 环境诊断失败", error);
  let stopUpdates: (() => void) | undefined;
  let observed: PaseoApi | null = null;
  const timelines = new Map<string, () => void>();
  const watching = new Map<string, symbol>();
  let closed = false;
  async function watch(agentId: string) {
    if (closed || timelines.has(agentId) || watching.has(agentId)) return;
    const token = Symbol(agentId);
    watching.set(agentId, token);
    try {
      const target = await placement(agentId);
      if (!target || closed || watching.get(agentId) !== token) return;
      const stop = api()
        .agents.ref(agentId)
        .timeline.subscribe(({ event }) => {
          if (
            event.type === "timeline" &&
            (event.item.type === "error" || event.item.type === "tool_call")
          ) {
            const text = timelineFailureText(event.item);
            if (text) void report(agentId, text).catch(log);
          }
          if (event.type === "turn_failed") void report(agentId, event.error, true).catch(log);
        });
      timelines.set(agentId, stop);
      void stop.ready.catch((error) => {
        if (timelines.get(agentId) === stop) timelines.delete(agentId);
        log(error);
      });
    } finally {
      if (watching.get(agentId) === token) watching.delete(agentId);
    }
  }
  function observe(paseo: PaseoApi) {
    if (closed || observed === paseo) return;
    stopUpdates?.();
    observed = paseo;
    stopUpdates = paseo.agents.subscribe((update) => {
      if (update.kind === "upsert" && update.agent.status === "error")
        void report(update.agent.id, update.agent.lastError ?? "agent startup failed", true).catch(
          log,
        );
    });
  }
  if (options.getPaseo()) observe(api());
  const stops = [
    server.on("agent.created", ({ agent }, context) => {
      observe(context.paseo);
      void watch(agent.id).catch(log);
    }),
    server.on("agent.archived", ({ agent }) => {
      watching.delete(agent.id);
      timelines.get(agent.id)?.();
      timelines.delete(agent.id);
    }),
    server.on("agent.closed", ({ agent }) => {
      timelines.get(agent.id)?.();
      timelines.delete(agent.id);
    }),
    server.on("agent.turn_started", async ({ agent }, context) => {
      observe(context.paseo);
      void watch(agent.id).catch(log);
      const projectId = await options.projects.projectForAgent(agent.id);
      if (projectId) options.projects.setError(projectId, null);
    }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, context) => {
      observe(context.paseo);
      if (outcome.kind === "failed") await report(agent.id, outcome.error.message, true).catch(log);
      // Tool process creation may fail while the provider still reports a completed turn.
      const page = await context.paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "tail", limit: 30 });
      for (const entry of page.entries) {
        if (turnId && entry.turnId !== turnId) continue;
        if (!["error", "tool_call", "tool_result"].includes(entry.item.type)) continue;
        const text = timelineFailureText(entry.item);
        if (text) await report(agent.id, text).catch(log);
      }
    }),
  ];
  const targetInput = z.object({ agentId: z.string().min(1) }).strict();
  async function guard(caller: string | null | undefined, agentId: string) {
    if (!caller) throw new Error("仅项目 agent 可以使用环境工具");
    const projectId = await options.projects.callerProject(caller);
    const target = await placement(agentId);
    if (!target || target.projectId !== projectId) throw new Error("只能诊断和恢复本项目会话");
    return projectId;
  }
  server.registerAgentTool({
    name: "vibe_env_diagnose",
    description:
      "项目 agent 专用，只读查询本项目会话最近环境错误、provider 诊断和就绪状态；不执行故障 agent 的 shell。",
    input: targetInput,
    handler: async (input, context) => {
      const { agentId } = targetInput.parse(input);
      const projectId = await guard(context.callerAgentId, agentId);
      const handle = api().agents.ref(agentId);
      await handle.refresh();
      const agent = handle.current();
      const providers = await api().providers.listAvailable();
      const diagnostic = agent
        ? await api()
            .providers.diagnostic(agent.provider)
            .catch((error) => ({ unavailable: diagnosticText(String(error)) }))
        : null;
      const [daemonLog, processes] = await Promise.all([
        recentDaemonLog(agentId),
        relatedProcesses(agent?.provider ?? ""),
      ]);
      return {
        log: daemonLog,
        processes,
        errors: errors.filter(
          (entry) => entry.projectId === projectId && entry.agentId === agentId,
        ),
        status: agent?.status,
        activeTurn: !!agent?.activeTurn,
        provider: agent?.provider,
        model: agent?.model,
        providers,
        diagnostic: diagnostic ? diagnosticText(JSON.stringify(diagnostic)) : null,
      };
    },
  });
  async function fallback(agentId: string) {
    const handle = api().agents.ref(agentId);
    await handle.refresh();
    const snapshot = handle.current();
    const workspaceId = snapshot?.workspaceId;
    const task = workspaceId ? options.store.tasks.get(workspaceId) : undefined;
    const tab = task?.tabs.find((entry) => entry.agentId === agentId);
    if (!workspaceId || !task || !tab || !options.tasks)
      throw new Error("无法找到可恢复的任务 tab");
    const preset = tab.presetId ? options.store.presets.get(tab.presetId) : undefined;
    const roleSnapshot =
      tab.role === "main" || tab.role === "session" ? undefined : task.rolesSnapshot?.[tab.role];
    const selected = Array.isArray(roleSnapshot)
      ? roleSnapshot.find((entry) => entry.presetId === tab.presetId)
      : roleSnapshot;
    const validated = TaskPresetSnapshotSchema.safeParse(selected);
    let candidates = preset ? presetModels(preset) : [];
    if (validated.success) candidates = validated.data.models;
    const index = candidates.findIndex(
      (candidate) => candidate.provider === tab.provider && candidate.model === tab.model,
    );
    const candidate = index >= 0 ? candidates[index + 1] : undefined;
    if (!candidate) throw new Error("预设候选模型已耗尽或当前模型不在候选中");
    const created = await api()
      .workspaces.ref(workspaceId)
      .agents.create({
        config: {
          provider: candidate.provider + "/" + candidate.model,
          ...(candidate.thinking ? { thinkingOptionId: candidate.thinking } : {}),
          ...((validated.success ? validated.data.fastMode : preset?.fastMode)
            ? { featureValues: { fast_mode: true } }
            : {}),
        },
        labels: {
          [TASK_TAB_ROLE_LABEL]: tab.role,
          ...(tab.presetId ? { [TASK_TAB_PRESET_LABEL]: tab.presetId } : {}),
        },
      });
    await options.tasks.tabs.ensureTab(created.id);
    await options.tasks.flow.handoff({
      workspaceId,
      agentId: created.id,
      requestId: "environment:" + agentId + ":" + created.id,
      reason: "#" + tab.number + " 环境故障候选模型接续",
    });
    return created.id;
  }
  const recoveryInput = targetInput.extend({ action: z.enum(["retry", "reopen", "fallback"]) });
  server.registerAgentTool({
    name: "vibe_env_recover",
    description:
      "项目 agent 专用，重试本项目的失败 tab 或恢复关闭的 tab。运行中的会话会拒绝；不会批准权限或结束其它进程。",
    input: recoveryInput,
    handler: async (input, context) => {
      const { agentId, action } = recoveryInput.parse(input);
      await guard(context.callerAgentId, agentId);
      const handle = api().agents.ref(agentId);
      await handle.refresh();
      if (handle.activeTurn || handle.pendingPermissions?.length)
        throw new Error("会话运行中或等待用户审批，不能自动恢复");
      if (action === "fallback") {
        return { ok: true, agentId: await fallback(agentId), action };
      } else if (action === "reopen") await handle.resume();
      else
        await handle.send(
          "[项目 agent 环境恢复请求，非用户授权] 请重试刚才因环境故障失败的操作；不增加原任务授权范围。",
          { sourceAgentId: context.callerAgentId ?? undefined },
        );
      return { ok: true, agentId, action };
    },
  });
  return {
    report,
    observe,
    close() {
      closed = true;
      watching.clear();
      stopUpdates?.();
      for (const stop of timelines.values()) stop();
      timelines.clear();
      for (const stop of stops) stop();
    },
  };
}
