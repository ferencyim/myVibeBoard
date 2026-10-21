// `agent.create` injection (WP-31). Claude receives the block through `systemPrompt`; providers
// that only read AGENTS files get a generated, git-hidden block in the working directory.
// Project detection: a `.vibe/` directory at the cwd (a worktree carries the committed copy).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createMemoryStore } from "../memory/store";
import { resolveVibeHome } from "../vibe/db";
import { installAgentsBlock, type AgentsTarget, type GitRunner } from "./agents-file";
import { buildContextBlock, CONTEXT_START, type ContextOptions } from "./content";

export * from "./agents-file";
export * from "./content";
export * from "./settings";

export type InjectionStrategy = "system-prompt" | AgentsTarget;

/** Provider id -> channel. Unlisted providers are left alone. */
export const PROVIDER_STRATEGY: Record<string, InjectionStrategy> = {
  claude: "system-prompt",
  codex: "AGENTS.override.md",
  kimi: "AGENTS.md",
  deepseek: "AGENTS.md",
  "deepseek-harness": "AGENTS.md",
};

export function strategyFor(provider: string): InjectionStrategy | null {
  return PROVIDER_STRATEGY[provider.split("/")[0].toLowerCase()] ?? null;
}

export interface InjectionOptions extends ContextOptions {
  /** Default memory budget (setting); a per-directory budget or `maxMemoryTokens` wins. */
  defaultMemoryTokens?: () => number;
  git?: GitRunner;
  userHome?: string;
  /** Per-directory memory budget (complexity policy): tight for multi-turn / long cards. */
  budgetFor?: (cwd: string) => number | undefined;
  log?: (message: string) => void;
}

export interface AgentCreateRequest {
  config: { provider: string; cwd: string; systemPrompt?: string };
}

/** Core of the hook: returns the config patch (a new systemPrompt) or null for no change. */
export async function injectContext(
  request: AgentCreateRequest,
  options: InjectionOptions = {},
): Promise<{ systemPrompt: string } | null> {
  const { provider, cwd } = request.config;
  const strategy = strategyFor(provider);
  if (!strategy || !existsSync(join(cwd, ".vibe"))) return null;
  const store = createMemoryStore({
    projectRoot: cwd,
    userHome: options.userHome ?? resolveVibeHome(),
    contextWindowTokens: 200_000,
  });
  const block = buildContextBlock(store, {
    ...options,
    maxMemoryTokens: options.budgetFor?.(cwd) ?? options.maxMemoryTokens ?? options.defaultMemoryTokens?.(),
  });
  if (!block) return null;
  if (strategy === "system-prompt") {
    const current = request.config.systemPrompt ?? "";
    // Prepend: the stable context stays the prefix whatever other plugins append.
    return current.includes(CONTEXT_START)
      ? null
      : { systemPrompt: current ? `${block}\n\n${current}` : block };
  }
  const result = await installAgentsBlock({ cwd, block, target: strategy, git: options.git });
  options.log?.(`vibe-context: ${provider}: ${result.note}`);
  return null;
}

export function registerInjection(server: PluginServerContext, options: InjectionOptions = {}) {
  return server.before("agent.create", async ({ request }) => {
    try {
      const patch = await injectContext(request, options);
      return patch ? { ...request, config: { ...request.config, ...patch } } : undefined;
    } catch (error) {
      // Context is best effort: never block the agent from starting.
      console.error("vibe-context: injection failed:", error);
      return undefined;
    }
  });
}
