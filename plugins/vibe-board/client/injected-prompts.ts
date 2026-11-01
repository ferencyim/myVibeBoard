/** Which registered prompts reach an agent: its role prompts first, then the shared ones. */
export interface PromptTarget {
  /** Task tab role; absent for agents outside a task workspace. */
  tabRole?: string;
  labels?: Record<string, string>;
}

const TAB_ROLE_KEYS: Record<string, readonly string[]> = {
  main: ["task.role.main", "task.plan_format"],
  planner: ["task.role.planner", "task.plan_format", "board.plan_review.request", "board.plan_review.revise"],
  scout: ["task.role.scout", "board.scout.ask"],
  worker: ["board.task.work", "verify.task.fix"],
  reviewer: ["verify.reviewer_system", "verify.task.review"],
  verifier: ["verify.verifier_system", "verify.task.setup", "verify.task.judge"],
};
const TASK_SHARED_KEYS = ["board.tabs.guide", "board.tabs.history_notice", "board.task.continuation"] as const;
const CONTEXT_KEYS = [
  "context.inject_frame",
  "context.cold_start",
  "context.failure_handoff",
  "context.compact_notes",
  "context.compact_restore",
] as const;
const MASTER_PREFIX = "master.";

export function injectedPromptKeys(target: PromptTarget, allKeys: readonly string[]): string[] {
  const own: string[] = [];
  const shared: string[] = [];
  if (target.tabRole) {
    own.push(...(TAB_ROLE_KEYS[target.tabRole] ?? []));
    shared.push(...TASK_SHARED_KEYS);
  } else if (target.labels?.["vibe.role"] === "project") {
    own.push("project.agent.role", "project.agent.task_done");
  } else if (target.labels?.role === "master") {
    own.push(...allKeys.filter((key) => key.startsWith(MASTER_PREFIX)));
  }
  shared.push(...CONTEXT_KEYS);
  const known = new Set(allKeys);
  return [...new Set([...own, ...shared])].filter((key) => known.has(key));
}

/** Prompts that belong to the agent's own role, as opposed to the shared handoff/context ones. */
export function ownPromptKeys(target: PromptTarget, allKeys: readonly string[]): Set<string> {
  const shared = new Set<string>([...TASK_SHARED_KEYS, ...CONTEXT_KEYS]);
  return new Set(injectedPromptKeys(target, allKeys).filter((key) => !shared.has(key)));
}
