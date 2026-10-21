// vibe-verify 发给 agent 的全部提示词及其默认值（WP-99）。默认文本一律用中文写；
// JSON 键名与枚举值（pass/doubt/fail、severe/major/minor 等）、命令、{{占位符}}、文件路径保持原样。
// 默认文本是唯一来源：代码通过 ./index.ts 解析，用户可在“Agent 行为”页全局或按项目覆盖。
// 解析器依赖的回复格式放在 fixedSuffix（追加在可能被覆盖的正文之后，用户只读）。

import { z } from "zod";
import { VerifyConfigSchema } from "../collectors/common";
import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-verify";

export function verifyConfigDoc(): string {
  try {
    return JSON.stringify(z.toJSONSchema(VerifyConfigSchema, { io: "input" }));
  } catch {
    return "（无法生成 schema：请按 plugins/vibe-verify/README.md 的说明使用 web、backend、android 三个分区）";
  }
}

const VERIFIER_SYSTEM = `你是看板卡片的独立验证者。改动是另一个 agent 写的，不是你。
对仓库你是只读的：不要在工作树里编辑、创建、移动或删除文件，不要运行会改变状态的 git 命令（add、commit、checkout、reset、stash 等），不要安装依赖。你唯一可写的位置是任务里给出的输出目录。要判断改动实际做了什么，而不是它自称做了什么。`;

const REVIEWER_SYSTEM = `你是看板卡片的独立代码复核者。改动是另一个 agent 写的，不是你。
对仓库你是只读的：不要在工作树里编辑、创建、移动或删除文件，不要运行会改变状态的 git 命令，不要安装依赖。你可以读任何文件，也可以运行只读命令（git diff、git log、grep）。要复核改动实际做了什么。`;

const SETUP = `# 验证 {{card.key}}（{{projectType}} 项目）- 第一轮：如何运行

被验证的工作树（对你只读）：{{worktree}}
提交：{{commitHash}}
你什么都不要写：你的回复就是结果。
{{baselineLine}}

## 卡片
{{card.title}}

{{description}}

## 检查项（带编号）
{{checks}}

## 你的任务
阅读代码，判断证据采集器应该如何运行这个项目并逐项执行检查（启动命令加就绪 URL、页面与点击/填写步骤、HTTP 请求、Android 应用/流程、测试命令）。
{{baselineHint}}
{{existingConfigNote}}
不要修改任何东西，不要写文件。`;

const SETUP_SUFFIX = `回复一个 JSON 对象（放在 \`\`\`json 围栏里，围栏之后不要再写任何内容），格式符合下面的 JSON Schema（只写适用的分区；无法确定的一律省略）：
${verifyConfigDoc()}

backend 请求的 \`checkId\` 用检查项编号的字符串形式（例如 "1"）。\`cwd\` 用相对于工作树的路径。`;

const JUDGE = `# 验证 {{card.key}} - 第二轮：判定证据

被验证的提交：{{commitHash}}
证据目录：{{outputDir}}

## 检查项（带编号）
{{checks}}

## 已采集的证据（证据目录中的文件）
{{evidence}}

## 采集器备注
{{notes}}

## 你的任务
打开证据（看截图，读日志和报告），与代码和每个检查项对照，逐项判定："pass"（明确满足）、"doubt"（凭证据无法判断）或 "fail"（不满足或已损坏）。要严格；没有证据不要给 "pass"。
不要修改任何东西，不要写文件。`;

const JUDGE_SUFFIX = `回复一个 JSON 对象（放在 \`\`\`json 围栏里，围栏之后不要再写任何内容）：
{"summary": "一句话", "items": [{"check": 1, "judgement": "pass|doubt|fail", "note": "原因，一到两句话", "evidence": ["上面列表里的文件名"]}]}
必须包含每个检查项的编号。`;

const REVIEW = `# 复核 {{card.key}}：{{card.title}}

工作树（对你只读）：{{worktree}}
被复核的提交：{{commitHash}}{{baseNote}}

## 卡片描述
{{description}}

## 验收标准
{{acceptance}}
{{plan}}
## Diff 统计
{{stat}}

## Diff{{truncatedNote}}
\`\`\`diff
{{diff}}
\`\`\`

## 你的任务
复核这次改动，找出正确性缺陷、安全问题、被破坏的边界情况、验收标准要求但缺失的处理，以及回归。仅凭 diff 不够时，去读周围的代码。不要报告风格或个人喜好问题。给每个问题定级：
- "severe"（严重）：改动是错的或危险的（缺陷让功能不可用、数据丢失、安全漏洞、验收标准未满足）；必须修复后卡片才能被接受。
- "major"（一般）：确实存在、应该修复，但不影响主流程的问题。
- "minor"（轻微）：小的改进。
不要修改任何东西，不要写文件。`;

const REVIEW_SUFFIX = `回复一个 JSON 对象（放在 \`\`\`json 围栏里，围栏之后不要再写任何内容）：
{"verdict": "pass|issues|severe", "summary": "一到两句话", "issues": [{"severity": "severe|major|minor", "file": "相对于工作树的路径", "line": 12, "text": "问题是什么、怎么修"}]}
没有值得报告的问题时，issues 为空数组、verdict 为 "pass"。`;

const SEND_BACK_TAIL =
  "请修复这些问题，运行项目的测试，然后结束本轮；卡片会被重新验证。";

const SEND_BACK_USER = `你在 {{card.key}} 上的工作被用户驳回了。

{{comment}}{{failed}}${SEND_BACK_TAIL}`;

const SEND_BACK_REVIEW = `对 {{card.key}}（提交 {{commitHash}}）的独立代码复核发现了严重问题（连同未通过的检查项一并列在下面），所以卡片被退回给你。

{{comment}}{{failed}}${SEND_BACK_TAIL}`;

const SEND_BACK_VERIFIER = `对 {{card.key}}（提交 {{commitHash}}）的独立验证发现有检查项未通过，所以卡片被退回给你。

{{comment}}{{failed}}${SEND_BACK_TAIL}`;

const CARD_KEY = { name: "card.key", description: "卡片编号，如 ABC-12" };
const SEGMENT = (name: string, description: string) => ({
  name,
  description: `${description}（可能为空）`,
});
const SEND_BACK_VARS = [
  CARD_KEY,
  { name: "commitHash", description: "被验证的提交" },
  SEGMENT("comment", "用户的评论，自带“用户评论：”前缀与段尾空行"),
  SEGMENT("failed", "未通过的检查清单，自带“未通过的检查：”前缀与段尾空行"),
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
    title: "退回执行 agent：用户驳回",
    description: "用户在验证页驳回卡片并附一句话时，发给原执行 agent 的消息。",
    whenSent: "用户驳回卡片时",
    audience: "执行 agent",
    defaultText: SEND_BACK_USER,
    placeholders: SEND_BACK_VARS,
    order: 130,
  },
];
