import type { TFunction } from "i18next";

/** Task tab numbers and names, mirroring the vibe-board role contract (`vibe.tab.role` label). */
const TASK_TAB_TARGETS: Record<string, string> = {
  main: "#1 主会话",
  planner: "#2 方案",
  scout: "#3 探路",
  worker: "#4 执行",
  reviewer: "#5 复核",
  verifier: "#6 验证",
};

export function resolveAgentTarget(input: {
  botName?: string | null;
  labels?: Record<string, string> | null;
}): string | null {
  if (input.botName) return input.botName;
  // Tasks created before role labels existed only carry tab-order "1" on their main session.
  const role =
    input.labels?.["vibe.tab.role"] ?? (input.labels?.["paseo.tab-order"] === "1" ? "main" : null);
  return (role && TASK_TAB_TARGETS[role]) || null;
}

/** A named placeholder for bot and task-tab conversations; undefined keeps the default one. */
export function resolveAgentPlaceholder(
  t: TFunction,
  input: { botName?: string | null; labels?: Record<string, string> | null; isDesktop: boolean },
): string | undefined {
  const name = resolveAgentTarget(input);
  if (!name) return undefined;
  return t(
    input.isDesktop ? "composer.placeholders.toTarget" : "composer.placeholders.toTargetMobile",
    { name },
  );
}
