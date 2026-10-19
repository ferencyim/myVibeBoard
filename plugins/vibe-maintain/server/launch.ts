// Paseo-backed implementations of the two agent ports (kept thin; the engine is tested with fakes).

import type { PaseoApi } from "@getpaseo/client";
import type { MaintenanceRule } from "./vibe/contract";
import type { FixLauncher, SubAgentRunner } from "./types";

type Api = Pick<PaseoApi, "agents" | "projects" | "workspaces">;

const normalizePath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const providerOf = (spec: string) => spec.split("/")[0] ?? spec;

/** Read-only-ish modes; the engine additionally compares `git status`/HEAD before and after. */
const READ_ONLY_MODE: Record<string, string> = { claude: "plan" };

export function createSubAgentRunner(deps: {
  getPaseo: () => Api | null;
  defaultAgent: () => string;
  timeoutMs?: number;
}): SubAgentRunner {
  return {
    async run({ rule, project, prompt }) {
      const paseo = deps.getPaseo();
      if (!paseo) throw new Error("No daemon handle yet");
      const spec = rule.agent ?? deps.defaultAgent();
      const modeId = READ_ONLY_MODE[providerOf(spec)];
      const agent = await paseo.agents.create({
        cwd: project.repoPath,
        title: `Maintenance: ${rule.name}`,
        labels: { role: "maintenance", ruleId: rule.id },
        env: { VIBE_ROLE: "maintenance" },
        config: { provider: spec, ...(modeId ? { modeId } : {}) },
      });
      try {
        const result = await agent.run(prompt, { timeoutMs: deps.timeoutMs ?? 10 * 60_000 });
        if (result.status !== "idle") {
          throw new Error(result.error ?? `sub agent ended with status ${result.status}`);
        }
        return result.lastMessage;
      } finally {
        await agent.archive().catch(() => undefined);
      }
    },
  };
}

export function createFixLauncher(deps: {
  getPaseo: () => Api | null;
  defaultAgent: () => string;
}): FixLauncher {
  const specOf = (rule: MaintenanceRule) => rule.agent ?? deps.defaultAgent();
  return {
    provider: (rule) => providerOf(specOf(rule)),
    async launch({ agentId, cardKey, rule, project, prompt }) {
      const paseo = deps.getPaseo();
      if (!paseo) throw new Error("Maintenance fixes need an active Paseo daemon connection");
      const { projects } = await paseo.projects.list();
      const target = projects.find(
        (p) => normalizePath(p.projectRootPath) === normalizePath(project.repoPath),
      );
      if (!target) throw new Error(`Project ${project.prefix} is not linked to a Paseo project`);
      const isGit = target.projectKind === "git";
      const title = `${cardKey} · ${rule.name}`;
      const slug = `${cardKey.toLowerCase()}-${rule.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
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
          : { kind: "directory", path: target.projectRootPath, projectId: target.projectId },
      });
      await workspace.agents.create({
        agentId,
        title,
        prompt,
        labels: { cardKey, role: "worker", origin: "maintenance", ruleId: rule.id },
        env: { VIBE_ROLE: "worker", VIBE_CARD_KEY: cardKey },
        config: { provider: specOf(rule) },
      });
      return { workspaceId: workspace.id, worktree: isGit ? workspace.directory : null };
    },
  };
}
