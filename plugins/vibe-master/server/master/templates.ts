// Wake message templates. The owner may override the editable body of each wake message in the
// settings; placeholders are written {{name}}. The reply-format section is NOT part of the template:
// it is appended by the plugin so a customised template can never break the JSON the parsers expect.

import type { PromptInfo, MasterSettings } from "../../shared/rpc";

export type TemplateId = "assess_draft" | "card_done" | "session_help";
type SettingKey = PromptInfo["settingKey"];

export interface TemplateDef {
  id: TemplateId;
  settingKey: SettingKey;
  label: string;
  description: string;
  placeholders: Array<{ name: string; description: string }>;
  defaultTemplate: string;
  formatSection(opts: { maintainRequirements: boolean }): string;
}

const PROJECT = { name: "project", description: "项目块：项目简介、类型、需求文档摘录、标签词表、执行预设、其它未完成卡片" };
const CARD = [
  { name: "card.key", description: "卡片编号，如 PROD-12" },
  { name: "card.title", description: "卡片标题" },
];

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  assess_draft: {
    id: "assess_draft",
    settingKey: "templateAssessDraft",
    label: "审查草稿",
    description: "草稿创建、修改、移回草稿或手动请求审查时发给总 agent 的消息。",
    placeholders: [
      PROJECT,
      ...CARD,
      { name: "card.priority", description: "优先级" },
      { name: "card.tags", description: "标签（逗号分隔）" },
      { name: "card.preset", description: "已预选的执行预设" },
      { name: "card.refImages", description: "参考图数量" },
      { name: "card.description", description: "卡片描述" },
      { name: "card.acceptance", description: "验收标准" },
      { name: "quota", description: "各 provider 剩余额度" },
      { name: "hint", description: "调度器对执行 agent 的提示" },
    ],
    defaultTemplate: `[wake:assess_draft]
{{project}}

## Card to assess (dynamic)
Key: {{card.key}}
Title: {{card.title}}
Priority: {{card.priority}}
Tags: {{card.tags}}
Preselected preset: {{card.preset}}
Reference images: {{card.refImages}}
Description:
{{card.description}}
Acceptance criteria:
{{card.acceptance}}

Provider quota: {{quota}}
Scheduler hint: {{hint}}`,
    formatSection: () =>
      `Optional additions to the JSON object: "verdict" is what the owner reads in the card chat (markdown, 2 to 6 sentences: is it feasible, what is unclear or risky, what you recommend; written in the card's language). "proposal" is {"title"?, "description"?, "acceptance"?, "rationale"} with replacement text for those card fields, only for a field that is really worth changing. You never edit the card's fields yourself; the owner accepts a proposal in the chat.\n\nReply with the assess_draft JSON object only.`,
  },
  card_done: {
    id: "card_done",
    settingKey: "templateCardDone",
    label: "卡片完成",
    description: "卡片进入完成列后，让总 agent 整理项目记忆（并按开关更新需求文档）的消息。",
    placeholders: [
      PROJECT,
      ...CARD,
      { name: "memory", description: "当前项目记忆条目（带编号）" },
      { name: "card.description", description: "卡片描述（截断）" },
      { name: "card.acceptance", description: "验收标准（截断）" },
      { name: "notes", description: "最近的备注、驳回、评估" },
      { name: "verification", description: "最近一次验证的结论与逐项结果" },
    ],
    defaultTemplate: `[wake:card_done]
{{project}}

## Current project memory (entry ids in brackets)
{{memory}}

## Finished card (dynamic)
Key: {{card.key}}
Title: {{card.title}}
Description:
{{card.description}}
Acceptance criteria:
{{card.acceptance}}
Recent notes:
{{notes}}
Verification:
{{verification}}`,
    formatSection: ({ maintainRequirements }) =>
      maintainRequirements
        ? `Optional: add "requirementsUpdate": {"content": "<the complete new requirements document>", "summary": "<one short line>"} only when this card changed the product requirements or settled a new product decision, and only when the requirements excerpt in the project block is complete (not marked as truncated). Never for implementation details.\n\nReply with the card_done JSON object only.`
        : "Reply with the card_done JSON object only.",
  },
  session_help: {
    id: "session_help",
    settingKey: "templateSessionHelp",
    label: "执行会话求助",
    description: "执行 agent 等待回答时，让总 agent 给你提建议的消息。",
    placeholders: [
      PROJECT,
      ...CARD,
      { name: "card.acceptance", description: "验收标准（截断）" },
      { name: "plan", description: "卡片当前计划" },
      { name: "question", description: "执行 agent 的提问（JSON）" },
    ],
    defaultTemplate: `[wake:session_help]
{{project}}

## Worker question (dynamic)
Card: {{card.key}} {{card.title}}
Acceptance criteria:
{{card.acceptance}}
Plan:
{{plan}}
Question:
{{question}}`,
    formatSection: () => "Reply with the session_help JSON object only.",
  },
};

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Replace `{{name}}`; unknown names become empty (the settings screen warns about them). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => vars[name] ?? "");
}

/** Placeholder names in `template` that the wake message does not provide. */
export function unknownPlaceholders(template: string, id: TemplateId): string[] {
  const known = new Set(TEMPLATES[id].placeholders.map((p) => p.name));
  const found = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  return [...new Set(found.filter((n) => !known.has(n)))];
}

/** Rendered body + the fixed reply-format section. */
export function composeWakeMessage(
  id: TemplateId,
  override: string | undefined,
  vars: Record<string, string>,
  opts: { maintainRequirements?: boolean } = {},
): string {
  const def = TEMPLATES[id];
  const body = renderTemplate(override?.trim() ? override : def.defaultTemplate, vars);
  return `${body}\n\n${def.formatSection({ maintainRequirements: !!opts.maintainRequirements })}`;
}

export function promptInfos(maintainRequirements: boolean): PromptInfo[] {
  return Object.values(TEMPLATES).map((d) => ({
    settingKey: d.settingKey,
    label: d.label,
    description: d.description,
    placeholders: d.placeholders,
    defaultTemplate: d.defaultTemplate,
    formatSection: d.formatSection({ maintainRequirements }),
  }));
}

export interface PromptOverrides {
  assess_draft?: string;
  card_done?: string;
  session_help?: string;
}

export function overridesFrom(s: MasterSettings): PromptOverrides {
  return {
    assess_draft: s.templateAssessDraft,
    card_done: s.templateCardDone,
    session_help: s.templateSessionHelp,
  };
}

/** Static rules + the owner's supplement. */
export function composeRules(base: string, supplement: string): string {
  const extra = supplement.trim();
  return extra ? `${base}\n\n## Owner supplement (from settings)\n\n${extra}` : base;
}
