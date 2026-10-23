import type { MaintenanceRule, Project } from "./vibe/contract";
import type { GitRunner } from "./git/exec";

/** One problem a check found. `category` groups findings in the task; `data` is free-form detail. */
export interface Finding {
  category: string;
  subject: string;
  detail: string;
  data?: unknown;
}

export interface CheckOutput {
  /** Task title when a new task is created. */
  title: string;
  /** Markdown body of the task / appended record. */
  body: string;
  findings: Finding[];
  /** Check limitations worth telling the user (skipped sub-checks, unsupported git, ...). */
  notes: string[];
  /** Overrides the rule's dedupe key (per-subject tasks, e.g. one per slow call site). */
  dedupeKey?: string;
  /** Extra instructions appended to the confirmed worker's prompt. */
  instructions?: string;
  /** Acceptance criteria of a new task (Markdown). */
  acceptance?: string;
  /** New task must be verified with captured evidence. */
  needsEvidence?: boolean;
  /** Called by the engine once the task exists (advance read cursors only now, so a failed run retries). */
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
  cursor: {
    get(key: string): number | undefined;
    set(key: string, value: number): void;
  };
  /** True while a not-done maintenance task with this dedupe key exists. */
  hasOpenTask(dedupeKey: string): boolean;
}

/** A deterministic check. Return null when there is nothing to report. */
export type CheckFn = (ctx: CheckContext) => Promise<CheckOutput | null>;
export type CheckRegistry = Record<string, CheckFn>;

/** Creates a native planning conversation. No execution authorization is granted. */
export interface MaintenanceTaskLauncher {
  launch(input: {
    rule: MaintenanceRule;
    project: Project;
    prompt: string;
    onCreated: (task: { workspaceId: string; anchorAgentId: string }) => void;
  }): Promise<{ workspaceId: string; anchorAgentId: string }>;
  append(input: { workspaceId: string; anchorAgentId: string; prompt: string }): Promise<void>;
}
