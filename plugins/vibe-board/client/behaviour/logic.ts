// Pure helpers of the "Agent 行为" page: grouping, labels and the editing rules of one scope.

import { PROMPT_ROLES, unknownPromptPlaceholders } from "../../shared/vibe/contract";

export interface BehaviourPrompt {
  key: string;
  plugin: string;
  role: string;
  title: string;
  description: string;
  whenSent: string;
  audience: string;
  defaultText: string;
  placeholders: Array<{ name: string; description: string }>;
  fixedSuffix: string;
  order: number;
  globalOverride: string | null;
  projectOverride: string | null;
  source: "default" | "global" | "project";
  effectiveText: string;
  overriddenProjects: string[];
}

export const ROLE_LABELS: Record<string, string> = {
  master: "总 agent",
  planner: "规划会话",
  executor: "执行 agent",
  scout: "探路兵",
  reviewer: "复核",
  verifier: "验证",
  maintenance: "自动维护",
  context: "上下文",
  handoff: "交接 / 切换",
  watchdog: "看门狗",
};

export const SOURCE_LABELS = { default: "默认", global: "全局覆盖", project: "项目覆盖" } as const;

/**
 * Plugin settings pages that hold automation parameters (the prompts themselves are listed below).
 * A plugin with a settings page gets one line here (pluginId + the page's screen id).
 */
export const AUTOMATION_LINKS = [
  {
    pluginId: "vibe-board",
    screenId: "task-default-models",
    label: "任务角色：默认模型与方案审阅超时",
  },
  {
    pluginId: "vibe-verify",
    screenId: "preferences",
    label: "验证与复核：自动退回、严重度映射、超时与摘录",
  },
  {
    pluginId: "vibe-context",
    screenId: "preferences",
    label: "上下文与压缩：缓存 TTL、压缩命令、记忆预算、复杂度分级",
  },
  {
    pluginId: "switch-provider",
    screenId: "preferences",
    label: "切换 provider：压缩历史的上限与摘要文字（该插件独立安装，文字在它自己的设置页里编辑）",
  },
  { pluginId: "vibe-scheduler", screenId: "preferences", label: "调度器：并发、资源与派发超时" },
] as const;

export const MAINTENANCE_HINT = "在总协调 bot 右侧『自动维护』面板中设置";

export interface RoleGroup {
  role: string;
  label: string;
  prompts: BehaviourPrompt[];
}

/** Known roles first (fixed order), unknown ones after; empty groups are omitted. */
export function groupByRole(prompts: readonly BehaviourPrompt[]): RoleGroup[] {
  const roles = [
    ...PROMPT_ROLES,
    ...[...new Set(prompts.map((p) => p.role))].filter(
      (r) => !(PROMPT_ROLES as readonly string[]).includes(r),
    ),
  ];
  return roles
    .map((role) => ({
      role,
      label: ROLE_LABELS[role] ?? role,
      prompts: prompts
        .filter((p) => p.role === role)
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    }))
    .filter((g) => g.prompts.length > 0);
}

/** The override the editor shows for this scope (null = none). */
export function ownOverride(p: BehaviourPrompt, projectId: string | null): string | null {
  return projectId ? p.projectOverride : p.globalOverride;
}

/** What applies when this scope has no override of its own. */
export function inheritedText(p: BehaviourPrompt, projectId: string | null): string {
  return projectId ? (p.globalOverride ?? p.defaultText) : p.defaultText;
}

/** The text the editor starts with. */
export function editorText(p: BehaviourPrompt, projectId: string | null): string {
  return ownOverride(p, projectId) ?? inheritedText(p, projectId);
}

/** Text to send on save: identical to what would be inherited means "no override of my own". */
export function textToSave(p: BehaviourPrompt, projectId: string | null, draft: string): string {
  return draft.trim() === inheritedText(p, projectId).trim() ? "" : draft;
}

export function unknownIn(p: BehaviourPrompt, draft: string): string[] {
  return p.placeholders.length === 0 ? [] : unknownPromptPlaceholders(draft, p.placeholders);
}

/** "当前生效来源" for the scope being edited. */
export function sourceIn(p: BehaviourPrompt, projectId: string | null): keyof typeof SOURCE_LABELS {
  if (projectId && p.projectOverride !== null) return "project";
  return p.globalOverride !== null ? "global" : "default";
}
