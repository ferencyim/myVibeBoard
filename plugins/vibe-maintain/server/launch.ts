// Paseo-backed implementations of the two agent ports (kept thin; the engine is tested with fakes).

import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import { TASK_PLAN_PROMPT } from "./vibe/contract/task";
import type { TaskRuntimeCommands, VibeStore } from "./vibe/db";
import type { MaintenanceTaskLauncher } from "./types";
import { resolveAgentCandidates, type AgentResolveDeps } from "./agent";
import { isModelUnavailableError } from "./vibe/contract";

type Api = Pick<PaseoApi, "agents" | "projects" | "workspaces">;

const normalizePath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

/** Planning never inherits a worker preset's write permission. */
export const READ_ONLY_MODE: Record<string, string> = {
  claude: "plan",
  codex: "read-only",
};

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
    readOnlyModes?: () => Record<string, string>;
    signal?: AbortSignal;
    isTaskRejected?: (workspaceId: string) => boolean;
  },
): MaintenanceTaskLauncher & { release(agentId: string): Promise<void> } {
  const planningMode = (provider: string): string => {
    const mode = (deps.readOnlyModes?.() ?? READ_ONLY_MODE)[provider];
    if (!mode || (READ_ONLY_MODE[provider] && mode !== READ_ONLY_MODE[provider]))
      throw new Error("维护规划必须配置只读模式：" + provider);
    return mode;
  };
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
  const api = () => {
    const paseo = deps.getPaseo();
    if (!paseo) throw new Error("维护规划需要已连接的原生 daemon");
    return paseo;
  };
  return {
    async launch({ rule, project, prompt, onCreated }) {
      const paseo = api();
      const candidates = resolveAgentCandidates(rule, project, deps);
      for (const candidate of candidates) planningMode(candidate.provider);
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
      for (const [index, candidate] of candidates.entries()) {
        const anchorAgentId = randomUUID();
        let bound = false;
        try {
          const anchor = await workspace.agents.create({
            agentId: anchorAgentId,
            title: "维护规划 · " + rule.name,
            labels: { role: "planner", origin: "maintenance", ruleId: rule.id },
            env: { VIBE_ROLE: "planner", VIBE_WORKSPACE_ID: workspace.id },
            config: {
              provider: candidate.spec,
              ...(candidate.provider === "codex"
                ? { options: { sandbox_mode: "read-only", approval_policy: "never" } }
                : { modeId: planningMode(candidate.provider) }),
              ...(candidate.thinkingOptionId
                ? { thinkingOptionId: candidate.thinkingOptionId }
                : {}),
            },
          });
          const existing = deps.store.tasks.get(workspace.id);
          if (existing && existing.anchorAgentId !== anchorAgentId)
            throw new Error("维护 workspace 已关联不同的规划 anchor");
          if (!existing) deps.store.tasks.create({ workspaceId: workspace.id, anchorAgentId });
          bound = true;
          onCreated({ workspaceId: workspace.id, anchorAgentId });
          const model =
            candidate.preset?.model || candidate.spec.slice(candidate.provider.length + 1);
          deps.runtime.registerSession({
            workspaceId: workspace.id,
            projectId: project.id,
            agentId: anchorAgentId,
            role: "planner",
            provider: candidate.provider,
            model,
            candidateIndex: index,
          });
          await reserve(
            workspace.id,
            anchorAgentId,
            candidate.provider,
            model,
            candidate.preset?.id,
          );
          await anchor.send(prompt + "\n\n" + TASK_PLAN_PROMPT.fixedSuffix, {
            sourceAgentId: anchorAgentId,
          });
          return { workspaceId: workspace.id, anchorAgentId };
        } catch (error) {
          // A bound task is authoritative even when delivery fails. Never create a second anchor.
          if (bound) {
            deps.store.tasks.setSummary(
              workspace.id,
              "维护首消息发送失败，请在原生会话重试：" + String(error),
            );
            throw error;
          }
          await paseo.agents
            .ref(anchorAgentId)
            .archive()
            .catch(() => undefined);
          if (!isModelUnavailableError(error) || index === candidates.length - 1) throw error;
        }
      }
      throw new Error("维护预设没有可用模型");
    },
    async append({ workspaceId, anchorAgentId, prompt }) {
      const session = deps.runtime.findSessionByAgent(anchorAgentId);
      if (!session?.model) throw new Error("维护规划缺少实际模型记录，禁止绕过调度");
      await reserve(workspaceId, anchorAgentId, session.currentProvider, session.model);
      await api()
        .agents.ref(anchorAgentId)
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
