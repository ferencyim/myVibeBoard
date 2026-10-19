import type { MaintenanceRule, Project } from "./vibe/contract";
import type { GitRunner } from "./git/exec";

/** One problem a check found. `category` groups findings in the card; `data` is free-form detail. */
export interface Finding {
  category: string;
  subject: string;
  detail: string;
  data?: unknown;
}

export interface CheckOutput {
  /** Card title when a new card is created. */
  title: string;
  /** Markdown body of the card / appended record. */
  body: string;
  findings: Finding[];
  /** Check limitations worth telling the user (skipped sub-checks, unsupported git, ...). */
  notes: string[];
}

export interface CheckContext {
  project: Project;
  rule: MaintenanceRule;
  /** `rule.check` without the `type` discriminator. */
  options: Record<string, unknown>;
  now: Date;
  git: GitRunner;
  /** Why the rule fired (and, for event triggers, what changed). */
  trigger: { reason: string; detail?: string[] };
}

/** A deterministic check. Return null when there is nothing to report. */
export type CheckFn = (ctx: CheckContext) => Promise<CheckOutput | null>;
export type CheckRegistry = Record<string, CheckFn>;

/** Optional read-only sub agent that turns the deterministic findings into a short action plan. */
export interface SubAgentRunner {
  run(input: { rule: MaintenanceRule; project: Project; prompt: string }): Promise<string | null>;
}

/** Starts the worker for a "fix" rule in its own worktree. The engine has already created the card. */
export interface FixLauncher {
  provider(rule: MaintenanceRule): string;
  launch(input: {
    agentId: string;
    cardKey: string;
    cardId: string;
    rule: MaintenanceRule;
    project: Project;
    prompt: string;
  }): Promise<{ workspaceId: string; worktree: string | null }>;
}
