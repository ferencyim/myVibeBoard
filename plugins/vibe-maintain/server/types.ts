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
  /** Overrides the rule's dedupe key (per-subject cards, e.g. one per slow call site). */
  dedupeKey?: string;
  /** Extra instructions appended to the fix worker's prompt. */
  instructions?: string;
  /** Acceptance criteria of a new card (Markdown). */
  acceptance?: string;
  /** New card must be verified with captured evidence. */
  needsEvidence?: boolean;
  /** Write a draft card even when the rule's output is "fix" (the check is not confident enough to automate). */
  forceDraft?: boolean;
  /** Called by the engine once the card exists (advance read cursors only now, so a failed run retries). */
  commit?: () => void;
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
  /** Persistent integer cursors of this rule (e.g. file read offsets). */
  cursor: { get(key: string): number | undefined; set(key: string, value: number): void };
  /** True while a not-done maintenance card with this dedupe key exists. */
  hasOpenCard(dedupeKey: string): boolean;
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
  /** Provider of the agent that will run the rule; throws a readable error when `rule.agent` is unusable. */
  provider(rule: MaintenanceRule, project: Project): string;
  launch(input: {
    agentId: string;
    cardKey: string;
    cardId: string;
    rule: MaintenanceRule;
    project: Project;
    prompt: string;
  }): Promise<{ workspaceId: string; worktree: string | null }>;
}
