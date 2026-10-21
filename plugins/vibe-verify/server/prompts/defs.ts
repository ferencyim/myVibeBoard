// Every prompt text vibe-verify sends to an agent, registered with its default (WP-99).
// The default text is the single source: code resolves through ./index.ts, the owner may override it
// globally or per project on the Agent behaviour page. Reply formats the parsers depend on live in
// fixedSuffix (appended after the possibly overridden body, read-only for the owner).

import { z } from "zod";
import { VerifyConfigSchema } from "../collectors/common";
import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-verify";

export function verifyConfigDoc(): string {
  try {
    return JSON.stringify(z.toJSONSchema(VerifyConfigSchema, { io: "input" }));
  } catch {
    return "(schema unavailable: use the sections web, backend, android as documented in plugins/vibe-verify/README.md)";
  }
}

const VERIFIER_SYSTEM = `You are an independent verifier for a kanban card. Another agent wrote the change; you did not.
You are READ-ONLY with respect to the repository: never edit, create, move or delete files in the working tree, never run git commands that change state (add, commit, checkout, reset, stash, ...), never install dependencies. Your only writable location is the output directory given in the task. Judge what the change actually does, not what it claims.`;

const REVIEWER_SYSTEM = `You are an independent code reviewer for a kanban card. Another agent wrote the change; you did not.
You are READ-ONLY with respect to the repository: never edit, create, move or delete files in the working tree, never run git commands that change state, never install dependencies. You may read any file and run read-only commands (git diff, git log, grep). Review what the change actually does.`;

const SETUP = `# Verify {{card.key}} ({{projectType}} project) - round 1: how to run it

Worktree under test (READ-ONLY for you): {{worktree}}
Commit: {{commitHash}}
You write nothing at all: your reply is the result.
{{baselineLine}}

## Card
{{card.title}}

{{description}}

## Checks (numbered)
{{checks}}

## Your task
Read the code and decide how an evidence collector should run this project and exercise each check (start command + ready URL, pages and click/fill steps, HTTP requests, Android app/flow, test command).
{{baselineHint}}
{{existingConfigNote}}
Do not modify anything; do not write files.`;

const SETUP_SUFFIX = `Reply with ONE JSON object (in a \`\`\`json fence, nothing after it) that follows this JSON Schema (only include the sections that apply; omit everything you cannot determine):
${verifyConfigDoc()}

Use the check number as string in \`checkId\` of backend requests (for example "1"). Use paths relative to the worktree for \`cwd\`.`;

const JUDGE = `# Verify {{card.key}} - round 2: judge the evidence

Commit under test: {{commitHash}}
Evidence directory: {{outputDir}}

## Checks (numbered)
{{checks}}

## Collected evidence (files in the evidence directory)
{{evidence}}

## Collector notes
{{notes}}

## Your task
Open the evidence (look at screenshots and read logs and reports), compare it with the code and each check, and judge every check: "pass" (clearly satisfied), "doubt" (cannot tell from the evidence) or "fail" (not satisfied or broken). Be strict; do not give "pass" without evidence.
Do not modify anything; do not write files.`;

const JUDGE_SUFFIX = `Reply with ONE JSON object (in a \`\`\`json fence, nothing after it):
{"summary": "one sentence", "items": [{"check": 1, "judgement": "pass|doubt|fail", "note": "why, one or two sentences", "evidence": ["file names from the list above"]}]}
Include every check number.`;

const REVIEW = `# Review {{card.key}}: {{card.title}}

Worktree (READ-ONLY for you): {{worktree}}
Reviewed commit: {{commitHash}}{{baseNote}}

## Card description
{{description}}

## Acceptance criteria
{{acceptance}}
{{plan}}
## Diff summary
{{stat}}

## Diff{{truncatedNote}}
\`\`\`diff
{{diff}}
\`\`\`

## Your task
Review the change for correctness bugs, security problems, broken edge cases, missing handling the acceptance criteria require, and regressions. Open the surrounding code when the diff alone is not enough. Do NOT report style or taste. Classify each issue:
- "severe": the change is wrong or dangerous (bug that breaks the feature, data loss, security hole, acceptance criterion not met); it must be fixed before the card can be accepted.
- "major": a real problem that should be fixed but does not break the main flow.
- "minor": small improvement.
Do not modify anything; do not write files.`;

const REVIEW_SUFFIX = `Reply with ONE JSON object (in a \`\`\`json fence, nothing after it):
{"verdict": "pass|issues|severe", "summary": "one or two sentences", "issues": [{"severity": "severe|major|minor", "file": "path/relative/to/worktree", "line": 12, "text": "what is wrong and how to fix it"}]}
Use an empty issues array and verdict "pass" when you find nothing worth reporting.`;

const SEND_BACK_TAIL =
  "Fix the problems, run the project's tests, and finish your round; the card will be verified again.";

const SEND_BACK_USER = `Your work on {{card.key}} was rejected by the user.

{{comment}}{{failed}}${SEND_BACK_TAIL}`;

const SEND_BACK_REVIEW = `Independent code review of {{card.key}} (commit {{commitHash}}) found severe problems (listed below together with any failing checks), so the card was sent back to you.

{{comment}}{{failed}}${SEND_BACK_TAIL}`;

const SEND_BACK_VERIFIER = `Independent verification of {{card.key}} (commit {{commitHash}}) found failing checks, so the card was sent back to you.

{{comment}}{{failed}}${SEND_BACK_TAIL}`;

const CARD_KEY = { name: "card.key", description: "卡片编号，如 ABC-12" };
const SEGMENT = (name: string, description: string) => ({
  name,
  description: `${description}（可能为空）`,
});
const SEND_BACK_VARS = [
  CARD_KEY,
  { name: "commitHash", description: "被验证的提交" },
  SEGMENT("comment", "主人的评论，自带“User comment:”前缀与段尾空行"),
  SEGMENT("failed", "未通过的检查清单，自带“Failed checks:”前缀与段尾空行"),
];

export const VERIFY_PROMPT_DEFS: readonly PromptDef[] = [
  {
    key: "verify.verifier_system",
    plugin: PLUGIN,
    role: "verifier",
    title: "验证 agent 系统提示",
    description:
      "独立验证 agent 的系统提示词：身份、只读约束。验证回合前后会比对代码树，改动了代码则本次证据作废。",
    whenSent: "卡片进入“验证中”、创建验证 agent 时",
    audience: "验证 agent",
    defaultText: VERIFIER_SYSTEM,
    order: 10,
  },
  {
    key: "verify.setup",
    plugin: PLUGIN,
    role: "verifier",
    title: "验证第一轮：如何运行",
    description:
      "要求验证 agent 阅读代码，决定证据采集器如何运行项目并执行各检查项。回复格式（verify 配置的 JSON Schema）固定附在末尾，不可编辑。",
    whenSent: "验证第一轮（证据模式）",
    audience: "验证 agent",
    defaultText: SETUP,
    placeholders: [
      CARD_KEY,
      { name: "projectType", description: "项目类型 web / backend / android 等" },
      { name: "worktree", description: "被验证的工作树路径" },
      { name: "commitHash", description: "被验证的提交" },
      { name: "baselineLine", description: "基线工作树说明（有或无）" },
      { name: "card.title", description: "卡片标题" },
      SEGMENT("description", "卡片描述"),
      { name: "checks", description: "带编号的检查项清单" },
      SEGMENT("baselineHint", "把基线路径写进 web.baseline.path 的提示"),
      SEGMENT("existingConfigNote", "仓库已有 .vibe/verify.json 的提示"),
    ],
    fixedSuffix: SETUP_SUFFIX,
    order: 20,
  },
  {
    key: "verify.judge",
    plugin: PLUGIN,
    role: "verifier",
    title: "验证第二轮：判定证据",
    description:
      "要求验证 agent 查看已采集的证据并逐项给出 pass / doubt / fail。回复格式固定附在末尾，不可编辑。",
    whenSent: "验证第二轮，证据采集完成后",
    audience: "验证 agent",
    defaultText: JUDGE,
    placeholders: [
      CARD_KEY,
      { name: "commitHash", description: "被验证的提交" },
      { name: "outputDir", description: "证据目录" },
      { name: "checks", description: "带编号的检查项清单" },
      { name: "evidence", description: "证据文件清单（含小日志的摘录）" },
      { name: "notes", description: "采集器与自动检查的备注" },
    ],
    fixedSuffix: JUDGE_SUFFIX,
    order: 30,
  },
  {
    key: "verify.reviewer_system",
    plugin: PLUGIN,
    role: "reviewer",
    title: "复核 agent 系统提示",
    description: "代码复核 agent 的系统提示词：身份、只读约束。",
    whenSent: "卡片配置了复核预设、验证后创建复核 agent 时",
    audience: "复核 agent",
    defaultText: REVIEWER_SYSTEM,
    order: 10,
  },
  {
    key: "verify.review",
    plugin: PLUGIN,
    role: "reviewer",
    title: "复核任务",
    description:
      "要求复核 agent 阅读改动并报告问题；这里定义严重 / 一般 / 轻微的含义（严重问题默认会使卡片自动退回）。回复格式固定附在末尾，不可编辑。",
    whenSent: "验证结束后、对卡片的改动做模型复核时",
    audience: "复核 agent",
    defaultText: REVIEW,
    placeholders: [
      CARD_KEY,
      { name: "card.title", description: "卡片标题" },
      { name: "worktree", description: "被复核的工作树路径" },
      { name: "commitHash", description: "被复核的提交" },
      { name: "baseNote", description: "与哪个基线提交比较的说明" },
      { name: "description", description: "卡片描述" },
      { name: "acceptance", description: "验收标准" },
      SEGMENT("plan", "最新计划段（自带标题与段尾空行）"),
      { name: "stat", description: "diff 统计" },
      { name: "truncatedNote", description: "diff 被截断时的说明" },
      { name: "diff", description: "改动 diff" },
    ],
    fixedSuffix: REVIEW_SUFFIX,
    order: 20,
  },
  {
    key: "verify.send_back.verifier",
    plugin: PLUGIN,
    role: "executor",
    title: "退回执行 agent：验证未通过",
    description: "验证有不通过的检查项时，发给原执行 agent 的消息。",
    whenSent: "验证失败且设置允许自动退回时",
    audience: "执行 agent",
    defaultText: SEND_BACK_VERIFIER,
    placeholders: SEND_BACK_VARS,
    order: 110,
  },
  {
    key: "verify.send_back.review",
    plugin: PLUGIN,
    role: "executor",
    title: "退回执行 agent：复核发现严重问题",
    description: "复核发现严重问题（可能连同失败的检查项）时，发给原执行 agent 的消息。",
    whenSent: "复核发现严重问题且设置允许自动退回、次数未用完时",
    audience: "执行 agent",
    defaultText: SEND_BACK_REVIEW,
    placeholders: SEND_BACK_VARS,
    order: 120,
  },
  {
    key: "verify.send_back.user",
    plugin: PLUGIN,
    role: "executor",
    title: "退回执行 agent：主人驳回",
    description: "主人在验证页驳回卡片并附一句话时，发给原执行 agent 的消息。",
    whenSent: "主人驳回卡片时",
    audience: "执行 agent",
    defaultText: SEND_BACK_USER,
    placeholders: SEND_BACK_VARS,
    order: 130,
  },
];
