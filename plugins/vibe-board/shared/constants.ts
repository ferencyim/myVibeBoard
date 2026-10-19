export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_THREAD_LIVE_STATUSES = [
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
] as const;

export type TaskThreadLiveStatus = (typeof TASK_THREAD_LIVE_STATUSES)[number];

export const PRESET_ENVIRONMENT_KINDS = [
  "project-default",
  "new-worktree",
] as const;

export type PresetEnvironmentKind = (typeof PRESET_ENVIRONMENT_KINDS)[number];

export const PRESET_PERMISSION_MODES = [
  "accept-edits",
  "auto",
  "full",
] as const;

export type PresetPermissionMode = (typeof PRESET_PERMISSION_MODES)[number];

export const TASK_SORTS = ["manual", "priority", "due"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const TASKS_PAGE_DEFAULT_LIMIT = 100;
export const TASKS_PAGE_MAX_LIMIT = 500;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const TASK_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export const PROJECT_COLORS = [
  "blue",
  "violet",
  "emerald",
  "orange",
  "rose",
  "amber",
  "cyan",
  "gray",
] as const;

export const COLOR_HEX: Readonly<Record<string, string>> = {
  blue: "#3b82f6",
  violet: "#8b5cf6",
  emerald: "#10b981",
  green: "#22c55e",
  orange: "#f97316",
  rose: "#f43f5e",
  red: "#ef4444",
  amber: "#f59e0b",
  yellow: "#eab308",
  cyan: "#06b6d4",
  gray: "#6b7280",
};

export function resolveColorHex(color: string): string {
  return COLOR_HEX[color.toLowerCase()] ?? (color.startsWith("#") ? color : "#3b82f6");
}

export function displayName(value: string): string {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export const TASK_CARD_KIND = "tasks-card";
export const TASK_TEXT_KIND = "tasks-text";
export const TASKS_SKILL_MARKER = "[paseo-plugin-tasks]";

export function buildTasksInstructions(): string {
  return `${TASKS_SKILL_MARKER}
# Paseo Tasks Integration
You have access to the Paseo Tasks tracker via both the \`paseo-tasks\` CLI (also aliased as \`bb-tasks\` and \`bb tasks\`) on your PATH and the \`tasks\` MCP server tools.
- Inspect a task: \`paseo-tasks show ABC-12\` (or \`--json\`) / MCP \`tasks_show\`
- List tasks: \`paseo-tasks list [--project ABC] [--status in_progress]\` / MCP \`tasks_list\`
- Create a task: \`paseo-tasks create --project ABC --title "..." [--priority high]\` / MCP \`tasks_create\`
- Update status/fields: \`paseo-tasks update ABC-12 --status in_review\` / MCP \`tasks_update\`
- Comment at milestones: \`paseo-tasks comment ABC-12 --body "..." [--notify]\` / MCP \`tasks_comment\`
- Attach or fetch files: \`paseo-tasks attachment add ABC-12 --file ./out.md\` and \`paseo-tasks attachment get <id> --out ./file\`
- Attach/detach your agent session: \`paseo-tasks attach ABC-12\` and \`paseo-tasks detach ABC-12\`
- When referring to a task in your reply, emit \`::task{key="ABC-12"}\` on its own line to render a live task card.`;
}

/** Quote a value as one literal POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function attachmentGetCommand(id: string, fileName: string): string {
  return `paseo-tasks attachment get ${id} --out ${shellQuote(`./${fileName}`)}`;
}
