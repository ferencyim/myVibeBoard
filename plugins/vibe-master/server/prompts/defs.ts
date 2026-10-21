// Every prompt text vibe-master sends, registered in the shared prompt registry (WP-98). The
// defaults live here and only here; the owner overrides them globally or per project on the
// "Agent behaviour" page. `fixedSuffix` carries the reply format the parsers expect, so a
// customised body can never break the JSON handling.

import type { PromptDef } from "../vibe/contract";
import { MASTER_RULES } from "../master/rules.generated";

const PLUGIN = "vibe-master";

const PROJECT = {
  name: "project",
  description: "项目块：项目简介、类型、需求文档摘录、标签词表、执行预设、其它未完成卡片",
};
const CARD = [
  { name: "card.key", description: "卡片编号，如 PROD-12" },
  { name: "card.title", description: "卡片标题" },
];

export interface MasterDefOptions {
  /** Base rules text (default: the SKILL.md rules). */
  rules?: string;
  /** Whether the card_done reply format offers the requirements update. */
  maintainRequirements?: boolean;
}

export function masterPromptDefs(options: MasterDefOptions = {}): PromptDef[] {
  const maintain = options.maintainRequirements ?? true;
  return [
    {
      key: "master.rules",
      plugin: PLUGIN,
      role: "master",
      title: "系统规则",
      description:
        "总 agent 与每个规划会话的系统提示正文（默认来自 skills/vibe-master/SKILL.md）。可整篇覆盖，恢复默认即回到 SKILL 生成的规则。覆盖后，运行中的会话会在下一条消息里收到完整新规则。",
      whenSent:
        "总 agent / 规划会话创建时作为系统提示；provider 不支持系统提示时随首条消息发送；规则文本变化后在下一条消息重发。",
      audience: "总 agent、规划会话",
      defaultText: options.rules ?? MASTER_RULES,
      placeholders: [],
      order: 0,
    },
    {
      key: "master.rules_supplement",
      plugin: PLUGIN,
      role: "master",
      title: "规则补充",
      description: "追加在系统规则之后的补充规则，与系统规则正文分开维护。留空表示没有补充。",
      whenSent: "与系统规则一起发送（附在其后）。",
      audience: "总 agent、规划会话",
      defaultText: "",
      placeholders: [],
      order: 1,
    },
    {
      key: "master.rules_updated",
      plugin: PLUGIN,
      role: "master",
      title: "规则更新通知",
      description: "系统规则或补充变化后，下一条消息开头附带的通知文字。",
      whenSent: "运行中的总 agent / 规划会话已收到旧规则，而当前规则文本哈希已变化时。",
      audience: "总 agent、规划会话",
      defaultText:
        "[Master rules updated - these replace all earlier rules and supplements]\n\n{{rules}}",
      placeholders: [{ name: "rules", description: "完整的当前规则（正文 + 补充）" }],
      order: 2,
    },
    {
      key: "master.wake.assess_draft",
      plugin: PLUGIN,
      role: "master",
      title: "审查草稿",
      description: "草稿创建、修改、移回草稿或手动请求审查时发给总 agent 的消息。",
      whenSent: "草稿卡创建/修改后防抖结束、卡片移回草稿、用户点「让总 agent 审查」。",
      audience: "总 agent",
      defaultText: `[wake:assess_draft]
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
      fixedSuffix:
        'Optional additions to the JSON object: "verdict" is what the owner reads in the card chat (markdown, 2 to 6 sentences: is it feasible, what is unclear or risky, what you recommend; written in the card\'s language). "proposal" is {"title"?, "description"?, "acceptance"?, "rationale"} with replacement text for those card fields, only for a field that is really worth changing. You never edit the card\'s fields yourself; the owner accepts a proposal in the chat.\n\nReply with the assess_draft JSON object only.',
      order: 10,
    },
    {
      key: "master.wake.card_done",
      plugin: PLUGIN,
      role: "master",
      title: "卡片完成",
      description: "卡片进入完成列后，让总 agent 整理项目记忆（并按开关更新需求文档）的消息。",
      whenSent: "卡片进入完成列后（启动补扫也会补发）。",
      audience: "总 agent",
      defaultText: `[wake:card_done]
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
      placeholders: [
        PROJECT,
        ...CARD,
        { name: "memory", description: "当前项目记忆条目（带编号）" },
        { name: "card.description", description: "卡片描述（截断）" },
        { name: "card.acceptance", description: "验收标准（截断）" },
        { name: "notes", description: "最近的备注、驳回、评估" },
        { name: "verification", description: "最近一次验证的结论与逐项结果" },
      ],
      fixedSuffix: maintain
        ? `Optional: add "requirementsUpdate": {"content": "<the complete new requirements document>", "summary": "<one short line>"} only when this card changed the product requirements or settled a new product decision, and only when the requirements excerpt in the project block is complete (not marked as truncated). Never for implementation details.\n\nReply with the card_done JSON object only.`
        : "Reply with the card_done JSON object only.",
      order: 11,
    },
    {
      key: "master.wake.session_help",
      plugin: PLUGIN,
      role: "master",
      title: "执行会话求助",
      description: "执行 agent 等待回答时，让总 agent 给你提建议的消息。",
      whenSent: "执行 agent 进入等待回答（提问）状态时。",
      audience: "总 agent",
      defaultText: `[wake:session_help]
{{project}}

## Worker question (dynamic)
Card: {{card.key}} {{card.title}}
Acceptance criteria:
{{card.acceptance}}
Plan:
{{plan}}
Question:
{{question}}`,
      placeholders: [
        PROJECT,
        ...CARD,
        { name: "card.acceptance", description: "验收标准（截断）" },
        { name: "plan", description: "卡片当前计划" },
        { name: "question", description: "执行 agent 的提问（JSON）" },
      ],
      fixedSuffix: "Reply with the session_help JSON object only.",
      order: 12,
    },
    {
      key: "master.repair_json",
      plugin: PLUGIN,
      role: "master",
      title: "JSON 修复请求",
      description: "总 agent 或规划会话的回复不符合约定格式时，要求它重新给出正确 JSON 的消息。",
      whenSent: "回复解析失败后（重试次数见总 agent 设置的「高级」分组）。",
      audience: "总 agent、规划会话",
      defaultText:
        "Your reply was rejected: {{error}}\nReply again with only the corrected {{kind}} JSON object in a ```json fence.",
      placeholders: [
        { name: "error", description: "解析失败的原因" },
        { name: "kind", description: "期望的 JSON 类型，如 assess_draft、card_done、plan_discussion" },
      ],
      order: 20,
    },
    {
      key: "master.plan.start",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：开场",
      description: "为一张卡片新开规划会话时的首条消息：卡片、项目块、项目记忆、最新计划与至今的讨论。",
      whenSent: "规划会话（新建或重建）收到用户第一批消息时。",
      audience: "规划会话",
      defaultText: `[plan:start]
You are the planning session of card {{card.key}}. Discuss the plan with the owner until it is executable.
{{project}}

## Project memory (read-only)
{{memory}}

## Card {{card.key}}
Title: {{card.title}}
Priority: {{card.priority}}
Tags: {{card.tags}}
Description:
{{card.description}}
Acceptance criteria:
{{card.acceptance}}

## Latest plan version
{{plan}}

{{discussion}}## Owner message(s) to answer now
{{pending}}`,
      placeholders: [
        PROJECT,
        ...CARD,
        { name: "memory", description: "项目记忆（只读）" },
        { name: "card.priority", description: "优先级" },
        { name: "card.tags", description: "标签（逗号分隔）" },
        { name: "card.description", description: "卡片描述" },
        { name: "card.acceptance", description: "验收标准" },
        { name: "plan", description: "最新计划版本" },
        { name: "discussion", description: "至今的讨论整段（含标题与结尾空行），没有则为空" },
        { name: "pending", description: "待回答的用户消息" },
      ],
      fixedSuffix: "Reply with the plan_discussion JSON object only.",
      order: 30,
    },
    {
      key: "master.plan.turn",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：后续回合",
      description: "规划会话继续讨论时，用户新消息的包装。",
      whenSent: "已有规划会话收到用户新消息时。",
      audience: "规划会话",
      defaultText: "[plan:turn]\n{{pending}}",
      placeholders: [{ name: "pending", description: "待回答的用户消息" }],
      fixedSuffix: "Reply with the plan_discussion JSON object only.",
      order: 31,
    },
    {
      key: "master.plan.research_results",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：探路结果",
      description: "规划会话派出探路兵后，把结果回给规划会话的消息。",
      whenSent: "规划会话请求调研、探路兵返回之后。",
      audience: "规划会话",
      defaultText: "[plan:research_results]\n\n{{results}}",
      placeholders: [{ name: "results", description: "各调研项的问题与结果（含失败说明）" }],
      fixedSuffix:
        "Continue the discussion with the plan_discussion JSON object only (no further research unless it is essential).",
      order: 32,
    },
    {
      key: "master.plan.handoff",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：写交接摘要",
      description: "用户把卡片移向待办时，让规划会话写交接摘要的消息。",
      whenSent: "用户把有规划会话的卡片移出草稿时。",
      audience: "规划会话",
      defaultText:
        "[plan:handoff]\nThe owner is moving this card to todo. Write the hand-off summary for the executing agent.",
      placeholders: [],
      fixedSuffix: 'Reply with `{ "summary": "<markdown>" }` only, in a ```json fence.',
      order: 33,
    },
    {
      key: "master.plan.scout",
      plugin: PLUGIN,
      role: "scout",
      title: "规划探路兵任务",
      description: "规划会话派出的只读探路兵收到的任务消息。",
      whenSent: "规划会话请求调研时，每个调研项各发一条给一个新的只读探路兵。",
      audience: "规划探路兵（只读）",
      defaultText: `You are a read-only scout for card {{card.key}} ({{card.title}}).
Answer the question below by reading code, logs or documents in this repository.
Do NOT modify, create or delete any file, do not run builds or install anything, do not use git commands that write.
Answer in at most 20 lines: findings with file paths, then the effort/risks if the question asks for an estimate.
Question: {{question}}{{scope}}`,
      placeholders: [
        ...CARD,
        { name: "question", description: "调研问题" },
        { name: "scope", description: "查找范围整行（含换行与 “Where to look:”），没有则为空" },
      ],
      order: 40,
    },
    {
      key: "master.handoff_summary",
      plugin: PLUGIN,
      role: "handoff",
      title: "总 agent 交接摘要",
      description: "更换总 agent 后，新总 agent 首条消息附带的摘要框架；各段内容由插件根据看板生成。",
      whenSent: "切换订阅、更换权限模式等导致新总 agent 启动，并在它收到第一条消息时。",
      audience: "新的总 agent",
      defaultText: `[handoff] 你接替上一任总 agent。以下摘要由插件根据看板生成，不依赖旧会话；细节用 vibe_show / vibe_list 查，不要凭记忆。

## 最近的切换
{{switches}}

## 最近审查结论（{{days}} 天内）
{{reviews}}

## 草稿与审查状态
{{drafts}}

## 近期完成的卡片
{{done}}`,
      placeholders: [
        { name: "switches", description: "最近的切换记录（每行一条）" },
        { name: "days", description: "「最近」的天数" },
        { name: "reviews", description: "最近审查结论" },
        { name: "drafts", description: "草稿与审查状态" },
        { name: "done", description: "近期完成的卡片" },
      ],
      order: 50,
    },
    {
      key: "master.plan.fallback_handoff",
      plugin: PLUGIN,
      role: "handoff",
      title: "规划交接兜底",
      description: "规划会话无法写出交接摘要（会话丢失或回复无效）时，由插件直接生成的交接文件框架。",
      whenSent: "用户移动卡片、规划会话写不出摘要时，写入 .vibe/sessions/<KEY>-plan.md 并交给执行 agent。",
      audience: "执行 agent（经派发 brief）",
      defaultText: `# Hand-off: {{card.key}} {{card.title}}

## Goal
{{goal}}

## Agreed plan (latest plan version)
{{plan}}{{lastWord}}`,
      placeholders: [
        ...CARD,
        { name: "goal", description: "卡片描述（无则标题）" },
        { name: "plan", description: "最新计划版本" },
        { name: "lastWord", description: "规划讨论最后一条回复整段（含标题），没有则为空" },
      ],
      order: 51,
    },
  ];
}

export type MasterPromptKey =
  | "master.rules"
  | "master.rules_supplement"
  | "master.rules_updated"
  | "master.wake.assess_draft"
  | "master.wake.card_done"
  | "master.wake.session_help"
  | "master.repair_json"
  | "master.plan.start"
  | "master.plan.turn"
  | "master.plan.research_results"
  | "master.plan.handoff"
  | "master.plan.scout"
  | "master.handoff_summary"
  | "master.plan.fallback_handoff";
