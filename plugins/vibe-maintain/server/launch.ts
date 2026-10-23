// Paseo-backed implementations of the two agent ports (kept thin; the engine is tested with fakes).

import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import {
  resolveAgent,
  resolveAgentCandidates,
  type AgentResolveDeps,
} from "./agent";
import { isModelUnavailableError } from "./vibe/contract";
import type { FixLauncher, SubAgentRunner } from "./types";

type Api = Pick<PaseoApi, "agents" | "projects" | "workspaces">;

const normalizePath = (p: string) =>
  p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

/** Read-only-ish modes; the engine additionally compares `git status`/HEAD before and after. */
export const READ_ONLY_MODE: Record<string, string> = {
  claude: "plan",
  codex: "read-only",
};
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;

export function createSubAgentRunner(
  deps: AgentResolveDeps & {
    getPaseo: () => Api | null;
    /** Milliseconds, or a getter so a settings change applies to the next run (default 10 minutes). */
    timeoutMs?: number | (() => number);
    /** Read-only mode id per provider (setting); defaults to READ_ONLY_MODE. */
    readOnlyModes?: () => Record<string, string>;
  }
): SubAgentRunner {
  return {
    async run({ rule, project, prompt }) {
      const paseo = deps.getPaseo();
      if (!paseo) throw new Error("No daemon handle yet");
      const candidates = resolveAgentCandidates(rule, project, deps);
      for (const [index, { spec, provider, thinkingOptionId }] of candidates.entries()) {
        const modeId = (deps.readOnlyModes?.() ?? READ_ONLY_MODE)[provider];
        let agent: Awaited<ReturnType<Api["agents"]["create"]>> | undefined;
        try {
          agent = await paseo.agents.create({
            cwd: project.repoPath,
            title: `Maintenance: ${rule.name}`,
            labels: { role: "maintenance", ruleId: rule.id },
            env: { VIBE_ROLE: "maintenance" },
            config: { provider: spec, ...(modeId ? { modeId } : {}), ...(thinkingOptionId ? { thinkingOptionId } : {}) },
          });
          const result = await agent.run(prompt, {
            timeoutMs:
              (typeof deps.timeoutMs === "function"
                ? deps.timeoutMs()
                : deps.timeoutMs) ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
          });
          if (result.status !== "idle") {
            throw new Error(
              result.error ?? `sub agent ended with status ${result.status}`
            );
          }
          return result.lastMessage;
        } catch (error) {
          if (!isModelUnavailableError(error)) throw error;
          if (index === candidates.length - 1)
            throw new Error(
              `维护预设中的模型均不可用：${
                error instanceof Error ? error.message : String(error)
              }`
            );
        } finally {
          await agent?.archive().catch(() => undefined);
        }
      }
      throw new Error("维护预设没有可用模型");
    },
  };
}

export function createFixLauncher(
  deps: AgentResolveDeps & { getPaseo: () => Api | null }
): FixLauncher {
  return {
    provider: (rule, project) => resolveAgent(rule, project, deps).provider,
    async launch({ agentId, cardKey, rule, project, prompt }) {
      const paseo = deps.getPaseo();
      if (!paseo)
        throw new Error(
          "Maintenance fixes need an active Paseo daemon connection"
        );
      const { projects } = await paseo.projects.list();
      const target = projects.find(
        (p) =>
          normalizePath(p.projectRootPath) === normalizePath(project.repoPath)
      );
      if (!target)
        throw new Error(
          `Project ${project.prefix} is not linked to a Paseo project`
        );
      const isGit = target.projectKind === "git";
      const title = `${cardKey} · ${rule.name}`;
      const slug = `${cardKey.toLowerCase()}-${rule.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`;
      const workspace = await paseo.workspaces.create({
        title,
        source: isGit
          ? {
              kind: "worktree",
              cwd: target.projectRootPath,
              projectId: target.projectId,
              action: "branch-off",
              worktreeSlug: slug.slice(0, 48),
            }
          : {
              kind: "directory",
              path: target.projectRootPath,
              projectId: target.projectId,
            },
      });
      const candidates = resolveAgentCandidates(rule, project, deps);
      for (const [index, agent] of candidates.entries()) {
        const actualAgentId = index === 0 ? agentId : randomUUID();
        try {
          await workspace.agents.create({
            agentId: actualAgentId,
            title,
            prompt,
            labels: {
              cardKey,
              role: "worker",
              origin: "maintenance",
              ruleId: rule.id,
            },
            env: { VIBE_ROLE: "worker", VIBE_CARD_KEY: cardKey },
            config: {
              provider: agent.spec,
              ...(agent.thinkingOptionId ? { thinkingOptionId: agent.thinkingOptionId } : {}),
              ...(agent.modeId ? { modeId: agent.modeId } : {}),
            },
          });
          return {
            workspaceId: workspace.id,
            worktree: isGit ? workspace.directory : null,
            agentId: actualAgentId,
            provider: agent.provider,
            presetId: agent.preset?.id,
            model: agent.preset?.model,
            modelIndex: index,
          };
        } catch (error) {
          await paseo.agents
            .ref(actualAgentId)
            .archive()
            .catch(() => undefined);
          if (!isModelUnavailableError(error)) throw error;
          if (index === candidates.length - 1)
            throw new Error(
              `维护预设中的模型均不可用：${
                error instanceof Error ? error.message : String(error)
              }`
            );
        }
      }
      throw new Error("维护预设没有可用模型");
    },
  };
}
