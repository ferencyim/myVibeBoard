// Prompt templates of maintenance rules. Pure (shared by the engine and the editor screen).
//
// Both output modes enter planning and wait for explicit task confirmation. Rule overrides only
// change the editable template; the appended constraint preserves the planning boundary.

export const PLACEHOLDERS = [
  { name: "project", description: "项目名称" },
  { name: "rule", description: "规则名称" },
  {
    name: "trigger_reason",
    description: "本次为什么触发，例如「已完成任务 10 个，达到阈值 10」或「手动触发」",
  },
  { name: "check_description", description: "这条规则检查什么（自然语言说明）" },
  // Preserve this historical placeholder in existing prompt overrides.
  { name: "card_title", description: "将要创建（或已创建）的任务标题" },
  { name: "summary", description: "检查生成的任务正文：触发原因、发现、影响、建议和验证方法" },
  { name: "findings_json", description: "全部发现的 JSON 明细" },
  { name: "findings_count", description: "发现的条数" },
  { name: "date", description: "运行日期（YYYY-MM-DD）" },
] as const;
export type PlaceholderName = (typeof PLACEHOLDERS)[number]["name"];
export type PromptVars = Record<PlaceholderName, string>;
export type PromptKind = "review" | "fix";

export const DEFAULT_REVIEW_TEMPLATE = [
  "你是项目「{{project}}」的维护复核员。自动维护规则「{{rule}}」刚刚触发，原因：{{trigger_reason}}。",
  "规则检查的内容：{{check_description}}",
  "",
  "下面是检查产出的任务发现和发现明细。请用中文写一份简短的整理方案，按优先级排序。每一项说明：",
  "1. 问题是什么、影响是什么；",
  "2. 建议怎么处理（哪些可以放心处理，哪些需要负责人决定）；",
  "3. 处理完后怎么验证。",
  "",
  "任务发现：",
  "{{summary}}",
  "",
  "发现明细（JSON，共 {{findings_count}} 条）：",
  "{{findings_json}}",
].join("\n");

export const DEFAULT_FIX_TEMPLATE = [
  "自动维护规则「{{rule}}」在项目「{{project}}」中发现了需要处理的问题，触发原因：{{trigger_reason}}。",
  "规则检查的内容：{{check_description}}",
  "",
  "请只读调查下面的问题，提出最小修复方案和验证方法。方案输出后等待用户显式 /执行，当前不得修改文件。",
  "",
  "任务发现：",
  "{{summary}}",
  "",
  "发现明细（JSON，共 {{findings_count}} 条）：",
  "{{findings_json}}",
].join("\n");

export const DEFAULT_TEMPLATES: Record<PromptKind, string> = {
  review: DEFAULT_REVIEW_TEMPLATE,
  fix: DEFAULT_FIX_TEMPLATE,
};

/** Appended by the system after the template; shown read-only in the editor. */
export const SYSTEM_CONSTRAINTS: Record<PromptKind, string> = {
  review: [
    "【系统约束，不可更改】",
    "- 你是只读复核员：不得修改任何文件、分支或 worktree，不得提交，不得执行会改变仓库状态的命令。",
    "- 输出中文维护方案；有歧义时向用户提问。方案完成后等待用户显式 /执行。",
  ].join("\n"),
  fix: [
    "【系统约束，不可更改】",
    "- 当前仅规划：不得修改文件、提交、合并或 push，不得自行执行修复；必须等待用户显式 /执行。",
    "- 只处理上面列出的问题，不做无关的重构或改动。",
    "- 说明拟改内容、风险与验证方法；生成方案不代表获得执行授权。",
  ].join("\n"),
};

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const KNOWN = new Set<string>(PLACEHOLDERS.map((p) => p.name));

/** Single pass: substituted values are never scanned again, unknown placeholders stay as written. */
export function renderTemplate(template: string, vars: PromptVars): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    KNOWN.has(name) ? vars[name as PlaceholderName] : whole,
  );
}

export function unknownPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!KNOWN.has(match[1]!)) found.add(match[1]!);
  }
  return [...found];
}

/** The full prompt: rendered template (custom or default), then the system constraint block. */
export function buildPrompt(
  kind: PromptKind,
  template: string | null | undefined,
  vars: PromptVars,
  extraInstructions?: string,
): string {
  const body = template?.trim() ? template : DEFAULT_TEMPLATES[kind];
  const parts = [renderTemplate(body, vars).trimEnd(), "", SYSTEM_CONSTRAINTS[kind]];
  if (extraInstructions?.trim())
    parts.push("", "【检查专属要求，不可更改】", extraInstructions.trim());
  return parts.join("\n");
}

export const MAINTENANCE_PROMPTS = (["review", "fix"] as const).map((kind) => ({
  key: "maintenance." + kind,
  plugin: "vibe-maintain",
  role: "planner" as const,
  placeholders: PLACEHOLDERS.map(({ name, description }) => ({ name, description })),
  title: kind === "review" ? "维护建议规划" : "维护修复规划",
  description: "维护发现先规划，经用户显式确认后才能执行。",
  whenSent: "维护规则发现需要处理的问题",
  audience: "规划 anchor",
  defaultText: DEFAULT_TEMPLATES[kind],
  fixedSuffix: SYSTEM_CONSTRAINTS[kind],
}));
