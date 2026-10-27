// Paseo-backed implementations of the two agent ports (kept thin; the engine is tested with fakes).

import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import { TASK_PLAN_PROMPT } from "./vibe/contract/task";
import type { TaskRuntimeCommands, VibeStore } from "./vibe/db";
import type { MaintenanceTaskLauncher } from "./types";
import { resolveAgentCandidates, type AgentResolveDeps } from "./agent";
import { UNRESOLVED_TAB_MODEL, isModelUnavailableError } from "./vibe/contract";

type Api = Pick<PaseoApi, "agents" | "projects" | "workspaces">;

const normalizePath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

export function createMaintenanceTaskLauncher(
  deps: AgentResolveDeps & {
    getPaseo: () => Api | null;
    store: VibeStore;
    runtime: TaskRuntimeCommands;
    resource: (input: {
      workspaceId: string;
      action: "acquire" | "bind" | "release";
      role?: "planner";
      provider?: string;
      model?: string;
      reservationId?: string;
      agentId?: string;
      presetId?: string;
    }) => Promise<{ ok: boolean; reason: string; reservationId?: string; retryable?: boolean }>;
    signal?: AbortSignal;
    isTaskRejected?: (workspaceId: string) => boolean;
    /** How long launch waits for vibe-board's #2 方案 tab before the anchor plans itself. */
    plannerTabWaitMs?: number;
  },
): MaintenanceTaskLauncher & { release(agentId: string): Promise<void> } {
  const held = new Map<string, { workspaceId: string; reservationId: string }>();
  const reserve = async (
    workspaceId: string,
    agentId: string,
    provider: string,
    model: string,
    presetId?: string,
  ) => {
    let lease: Awaited<ReturnType<typeof deps.resource>>;
    for (;;) {
      const task = deps.store.tasks.get(workspaceId);
      if (
        deps.signal?.aborted ||
        deps.isTaskRejected?.(workspaceId) ||
        !task ||
        task.confirmedAt ||
        !["planning", "awaiting_confirmation"].includes(task.phase)
      )
        throw new Error("维护规划已停止或确认状态已变化");
      lease = await deps.resource({
        workspaceId,
        action: "acquire",
        role: "planner",
        provider,
        model,
        ...(presetId ? { presetId } : {}),
      });
      if (lease.ok && lease.reservationId) break;
      if (!lease.retryable) throw new Error("维护规划资源未准入：" + lease.reason);
      deps.store.tasks.setSummary(workspaceId, "维护规划等待资源：" + lease.reason);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const reservationId = lease.reservationId!;
    held.set(agentId, { workspaceId, reservationId });
    const bound = await deps.resource({ workspaceId, action: "bind", reservationId, agentId });
    if (!bound.ok) throw new Error("维护规划资源绑定失败：" + bound.reason);
  };
  /** #2 方案 that vibe-board pre-creates for the task; without vibe-board (or when it is slow) the
   *  anchor plans as before. */
  const planningTarget = async (
    workspaceId: string,
    anchorAgentId: string,
    candidate: { provider: string; spec: string; preset?: { model: string } },
  ): Promise<{ agentId: string; provider: string; model: string }> => {
    const deadline = Date.now() + (deps.plannerTabWaitMs ?? 30_000);
    for (;;) {
      const tab = deps.store.tasks.get(workspaceId)?.tabs.find((item) => item.role === "planner");
      if (tab && tab.model !== UNRESOLVED_TAB_MODEL)
        return { agentId: tab.agentId, provider: tab.provider, model: tab.model };
      if (Date.now() >= deadline || deps.signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      agentId: anchorAgentId,
      provider: candidate.provider,
      model: candidate.preset?.model || candidate.spec.slice(candidate.provider.length + 1),
    };
  };
  const api = () => {
    const paseo = deps.getPaseo();
    if (!paseo) throw new Error("维护规划需要已连接的原生 daemon");
    return paseo;
  };
  return {
    async launch({ rule, project, prompt, onCreated }) {
      const paseo = api();
      const candidates = resolveAgentCandidates(rule, project, deps);
      const { projects } = await paseo.projects.list();
      const matches = projects.filter((entry) =>
        project.paseoProjectId
          ? entry.projectId === project.paseoProjectId
          : normalizePath(entry.projectRootPath) === normalizePath(project.repoPath),
      );
      if (matches.length > 1)
        throw new Error("维护项目对应多个原生项目，请先确认项目关联：" + project.name);
      const target = matches[0];
      if (!target) throw new Error("维护项目尚未关联原生项目：" + project.name);
      if (target.projectKind !== "git")
        throw new Error(
          "维护发现已保留：该项目不是 Git 仓库，无法创建独立 worktree；请先将项目初始化为 Git 仓库。",
        );
      deps.store.projectConfigs.link(target.projectId, target.projectRootPath);
      const workspace = await paseo.workspaces.create({
        title: "维护规划 · " + rule.name,
        source: {
          kind: "worktree",
          cwd: target.projectRootPath,
          projectId: target.projectId,
          action: "branch-off",
          worktreeSlug: "maintain-" + randomUUID().slice(0, 12),
        },
      });
      // Round 8 (WP-130): the task exists before its first agent, so vibe-board numbers the
      // anchor #1 主会话 and pre-creates #2 方案 … #6 验证 at once. The rule's preset writes the plan
      // in #2 (a task-level planner selection), and the maintenance prompt goes to #2.
      let anchorAgentId = randomUUID();
      const presetId = candidates[0]?.preset?.id;
      deps.store.db.immediate(() => {
        deps.store.tasks.create({ workspaceId: workspace.id, anchorAgentId });
        if (presetId)
          deps.store.tasks.setRoleSelections(workspace.id, {
            planner: { mode: "preset", presetId },
          });
        deps.store.tasks.markTaskWorkspace(workspace.id);
      });
      // No candidate came up: roll the task back and archive its workspace, so no ghost task stays
      // on the board, in the scheduler or in the project plan list.
      const abandon = async (reason: string) => {
        try {
          deps.store.tasks.discardUnstarted(workspace.id, { expectedAnchorAgentId: anchorAgentId });
        } catch (error) {
          deps.store.tasks.setSummary(workspace.id, "维护规划未能启动：" + reason);
          console.error("[vibe-maintain] 维护任务回滚失败", error);
        }
        await paseo.workspaces
          .archive(workspace.id)
          .catch((error) => console.error("[vibe-maintain] 维护 workspace 归档失败", error));
      };
      let anchorCandidate: (typeof candidates)[number] | undefined;
      for (const [index, candidate] of candidates.entries()) {
        try {
          await workspace.agents.create({
            agentId: anchorAgentId,
            title: "维护规划 · " + rule.name,
            labels: { role: "main", origin: "maintenance", ruleId: rule.id },
            env: { VIBE_ROLE: "main", VIBE_WORKSPACE_ID: workspace.id },
            config: {
              provider: candidate.spec,
              ...(candidate.thinkingOptionId
                ? { thinkingOptionId: candidate.thinkingOptionId }
                : {}),
            },
          });
          anchorCandidate = candidate;
          break;
        } catch (error) {
          await paseo.agents
            .ref(anchorAgentId)
            .archive()
            .catch(() => undefined);
          if (!isModelUnavailableError(error) || index === candidates.length - 1) {
            await abandon(String(error));
            throw error;
          }
          const next = randomUUID();
          deps.store.tasks.replaceAnchor(workspace.id, {
            expectedAnchorAgentId: anchorAgentId,
            anchorAgentId: next,
          });
          anchorAgentId = next;
        }
      }
      if (!anchorCandidate) {
        await abandon("维护预设没有可用模型");
        throw new Error("维护预设没有可用模型");
      }
      onCreated({ workspaceId: workspace.id, anchorAgentId });
      // A bound task is authoritative even when delivery fails. Never create a second anchor.
      try {
        const target = await planningTarget(workspace.id, anchorAgentId, anchorCandidate);
        if (!deps.runtime.findSessionByAgent(target.agentId))
          deps.runtime.registerSession({
            workspaceId: workspace.id,
            projectId: project.id,
            agentId: target.agentId,
            role: "planner",
            provider: target.provider,
            model: target.model,
            candidateIndex: 0,
          });
        await reserve(workspace.id, target.agentId, target.provider, target.model, presetId);
        await paseo.agents
          .ref(target.agentId)
          .send(prompt + "\n\n" + TASK_PLAN_PROMPT.fixedSuffix, { sourceAgentId: anchorAgentId });
        return { workspaceId: workspace.id, anchorAgentId };
      } catch (error) {
        deps.store.tasks.setSummary(
          workspace.id,
          "维护首消息发送失败，请在原生会话重试：" + String(error),
        );
        throw error;
      }
    },
    async append({ workspaceId, anchorAgentId, prompt }) {
      // Round-8 tasks plan in #2 方案. A task launched before round 8 planned in its anchor and
      // only gets a 方案 tab later, after its 执行 tab: new findings stay with the anchor.
      const tabs = deps.store.tasks.get(workspaceId)?.tabs ?? [];
      const planner = tabs.find((item) => item.role === "planner");
      const worker = tabs.find((item) => item.role === "worker");
      const tab = planner && (!worker || planner.number < worker.number) ? planner : undefined;
      const agentId = tab?.agentId ?? anchorAgentId;
      const session = deps.runtime.findSessionByAgent(agentId);
      const model = session?.model ?? (tab && tab.model !== UNRESOLVED_TAB_MODEL ? tab.model : "");
      if (!model) throw new Error("维护规划缺少实际模型记录，禁止绕过调度");
      await reserve(workspaceId, agentId, session?.currentProvider ?? tab!.provider, model);
      await api()
        .agents.ref(agentId)
        .send(prompt + "\n\n" + TASK_PLAN_PROMPT.fixedSuffix, { sourceAgentId: anchorAgentId });
    },
    async release(agentId) {
      const lease = held.get(agentId);
      if (!lease) return;
      const result = await deps.resource({ ...lease, action: "release" });
      if (result.ok) held.delete(agentId);
    },
  };
}
