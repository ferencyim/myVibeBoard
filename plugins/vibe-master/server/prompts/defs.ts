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
        "总 agent 的系统提示正文（默认来自 skills/vibe-master/SKILL.md）。可整篇覆盖，恢复默认即回到 SKILL 生成的规则。覆盖后，运行中的总 agent 会在下一条消息里收到完整新规则。",
      whenSent:
        "总 agent 创建时作为系统提示；provider 不支持系统提示时随首条消息发送；规则文本变化后在下一条消息重发。",
      audience: "总 agent",
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
      audience: "总 agent",
      defaultText: "",
      placeholders: [],
      order: 1,
    },
    {
      key: "master.rules_updated",
      plugin: PLUGIN,
      role: "master",
      title: "规则更新通知",
      description: "系统规则（或规划会话的系统提示）变化后，下一条消息开头附带的通知文字。",
      whenSent: "运行中的总 agent / 规划会话已收到旧文本，而当前文本哈希已变化时。",
      audience: "总 agent、规划会话",
      defaultText:
        "[总 agent 规则已更新：以下规则取代此前所有规则和补充]\n\n{{rules}}",
      placeholders: [{ name: "rules", description: "完整的当前规则（正文 + 补充）" }],
      order: 2,
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

## 当前项目记忆（方括号内为条目编号）
{{memory}}

## 已完成的卡片（动态）
编号：{{card.key}}
标题：{{card.title}}
描述：
{{card.description}}
验收标准：
{{card.acceptance}}
最近的备注：
{{notes}}
验证结果：
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
        ? `可选：仅当这张卡片改变了产品需求或确定了新的产品决定、并且项目块里的需求文档摘录是完整的（未标 TRUNCATED）时，才加上 "requirementsUpdate": {"content": "<完整的新需求文档>", "summary": "<一句简短的话>"}。实现细节绝不写入。\n\n只回复 card_done JSON 对象。`
        : "只回复 card_done JSON 对象。",
      order: 11,
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
        "你的回复被拒绝：{{error}}\n请只重新回复修正后的 {{kind}} JSON 对象，放在 ```json 围栏里。",
      placeholders: [
        { name: "error", description: "解析失败的原因" },
        { name: "kind", description: "期望的 JSON 类型，如 card_done、plan" },
      ],
      order: 20,
    },
    {
      key: "master.plan.system",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：系统提示",
      description:
        "卡片「方案」页规划会话的系统提示：它的角色和工作方式。规划会话用卡片上选的规划模型，在项目仓库里以只读模式运行。",
      whenSent:
        "规划会话创建时作为系统提示；provider 不支持系统提示时随首条消息发送；文本变化后在下一条消息重发。",
      audience: "规划会话",
      defaultText: `你是一张卡片的规划会话：负责人点了「制定方案」或在方案对话里给你发消息。你的任务是和负责人一起把这张卡片的方案和验收标准定下来，让执行模型拿到后能直接动手。

- 你在项目仓库里以只读模式运行：可以阅读代码、文档和日志，不要修改、创建或删除任何文件，不要运行会写入的命令。
- 方案只有一版，存在卡片上。每次方案有变化就给出**完整的**新方案（不是增量），它会直接覆盖旧方案。
- 方案写清楚：目标、做法与步骤、涉及的模块和文件、约束与风险、不在范围内的事。具体到执行模型不用再猜。
- 执行时由一个主代理统筹、若干子代理分头完成，所以方案要拆成子任务（subtasks）：每个子任务写清目标、方法、注意事项、验收标准、涉及文件，以及依赖哪些子任务先完成。
  - 子任务要能独立交给一个子代理完成；涉及文件尽量不重叠，重叠的子任务不会同时运行。可以并行的不要写成依赖。
  - 简单任务只拆 1 个子任务即可，不要为拆而拆。
  - 某个子任务明显适合别的模型（更便宜、更强、特定运行环境）时，用项目块里「执行预设」的名称填 preset；否则不填，用卡片上的子代理默认模型。
  - 负责人可能直接改过子任务；你再改时照常给出完整的子任务列表，插件会以建议的形式交给负责人决定，不会覆盖负责人的修改。
- 验收标准由你起草：每行一条，可观察、可验证（命令结果、页面表现、截图等）。负责人可能直接改过验收标准；你再改时照常给出完整新版本，插件会以建议的形式交给负责人决定，不会覆盖负责人的修改。
- 有不清楚、互相冲突或需要负责人决定的地方，就在回复里直接提问，等负责人回答后再定稿。一次只问最关键的几个问题。
- 负责人在对话里发来修改要求时，按要求更新方案并说明改了什么。
- 需要大范围查找代码时，可以请探路模型去查（research），它只读、便宜；卡片没选探路模型时自己读代码。
- 卡片的标题或描述本身需要改时，用 proposal 提建议，负责人采纳后才会写入；你从不直接改它们。
- 用卡片的语言（通常是中文）回复。`,
      placeholders: [],
      fixedSuffix: `## 回复格式（插件解析，必须遵守）

每次只回复一个放在 \`\`\`json 围栏里的 JSON 对象：

\`\`\`json
{
  "reply": "对负责人说的话（markdown）：结论、问题、改了什么",
  "research": [{ "question": "要探路模型查清的问题", "scope": "查哪里，可选" }],
  "plan": {
    "text": "完整方案（markdown）",
    "files": ["src/feature/**"],
    "subtasks": [
      {
        "id": "s1",
        "title": "子任务标题",
        "goal": "要达成什么",
        "method": "怎么做、步骤",
        "notes": "注意事项：约束、风险、不要碰的地方",
        "acceptance": "这个子任务的验收标准",
        "files": ["src/feature/a.ts"],
        "dependsOn": [],
        "preset": "执行预设名称，可选"
      }
    ]
  },
  "acceptance": "完整的验收标准，每行一条",
  "proposal": { "title": "新标题，可选", "description": "新描述，可选", "rationale": "理由" }
}
\`\`\`

- "reply" 必填；其它字段可选，没有变化就省略。
- "plan" 与 "acceptance" 一旦给出就是完整的新版本，会覆盖卡片上的旧内容（负责人改过的验收标准除外，见上文）。
- "plan.files" 列出方案会改动的文件、目录或通配符（调度器据此避免并行冲突），不知道就写 []。
- "plan.subtasks" 是完整的子任务列表（1 个或多个）：id 用 s1、s2…且不重复；"dependsOn" 只能写列表里已有的 id，不能成环；"preset" 不认识的名称按未指定处理。
- "research" 最多 3 个问题；插件跑完后把结果以 [plan:research_results] 发回给你。`,
      order: 29,
    },
    {
      key: "master.plan.start",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：开场",
      description:
        "「制定方案」或新规划会话的首条消息：项目块、项目记忆、卡片、当前方案与验收标准、探路结果、至今的方案对话。中途换了规划模型时，新模型靠这条消息接着做。",
      whenSent: "点「制定方案」时；规划会话新建（含换规划模型、守护进程重启后会话丢失）后的第一条消息。",
      audience: "规划会话",
      defaultText: `[plan:start]
{{project}}

## 项目记忆（只读）
{{memory}}

## 卡片 {{card.key}}
标题：{{card.title}}
优先级：{{card.priority}}
标签：{{card.tags}}
描述：
{{card.description}}

## 当前方案
{{plan}}

## 当前验收标准
{{card.acceptance}}

{{findings}}{{discussion}}## 现在需要处理的负责人消息
{{pending}}`,
      placeholders: [
        PROJECT,
        ...CARD,
        { name: "memory", description: "项目记忆（只读）" },
        { name: "card.priority", description: "优先级" },
        { name: "card.tags", description: "标签（逗号分隔）" },
        { name: "card.description", description: "卡片描述" },
        { name: "card.acceptance", description: "当前验收标准" },
        { name: "plan", description: "卡片上的当前方案" },
        { name: "findings", description: "制定方案前探路的结果整段（含标题与结尾空行），没有则为空" },
        { name: "discussion", description: "至今的方案对话整段（含标题与结尾空行），没有则为空" },
        { name: "pending", description: "待处理的负责人消息" },
      ],
      fixedSuffix: "只回复规划 JSON 对象（格式见系统提示）。",
      order: 30,
    },
    {
      key: "master.plan.turn",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：后续回合",
      description: "规划会话继续时，负责人新消息（回答问题或修改要求）的包装。",
      whenSent: "已有规划会话收到负责人在方案对话里的新消息时。",
      audience: "规划会话",
      defaultText: "[plan:turn]\n{{pending}}",
      placeholders: [{ name: "pending", description: "待处理的负责人消息" }],
      fixedSuffix: "只回复规划 JSON 对象（格式见系统提示）。",
      order: 31,
    },
    {
      key: "master.plan.research_results",
      plugin: PLUGIN,
      role: "planner",
      title: "规划会话：探路结果",
      description: "规划会话请探路模型调查后，把结果回给规划会话的消息。",
      whenSent: "规划会话请求调研、探路模型返回之后。",
      audience: "规划会话",
      defaultText: "[plan:research_results]\n\n{{results}}",
      placeholders: [{ name: "results", description: "各调研项的问题与结果（含失败说明）" }],
      fixedSuffix: "继续，只回复规划 JSON 对象（除非必不可少，不要再发起调研）。",
      order: 32,
    },
    {
      key: "master.plan.explore",
      plugin: PLUGIN,
      role: "scout",
      title: "制定方案前的探路问题",
      description: "点「制定方案」且卡片选了探路模型时，先让探路模型调查的问题；结果交给规划模型。",
      whenSent: "「制定方案」开始时（选了探路模型才发）。",
      audience: "探路模型（只读）",
      defaultText: `为卡片 {{card.key}}「{{card.title}}」制定方案做准备：找出与它相关的代码、文档和配置，说明现有实现是怎样的、需要改哪些地方、有哪些约束和风险。

卡片描述：
{{card.description}}`,
      placeholders: [...CARD, { name: "card.description", description: "卡片描述（截断）" }],
      order: 39,
    },
    {
      key: "master.plan.scout",
      plugin: PLUGIN,
      role: "scout",
      title: "规划探路兵任务",
      description: "探路模型（卡片上选的）收到的任务消息：制定方案前的探路，以及规划会话请求的调研。",
      whenSent: "「制定方案」开始时与规划会话请求调研时，每个问题各发给一个新的只读探路会话。",
      audience: "探路模型（只读）",
      defaultText: `你是卡片 {{card.key}}（{{card.title}}）的只读探路模型。
通过阅读本仓库的代码、日志或文档来回答下面的问题。
不要修改、创建或删除任何文件，不要运行构建或安装任何东西，不要使用会写入的 git 命令。
回答不超过 20 行：先写带文件路径的发现；如果问题要求估算，再写工作量和风险。
问题：{{question}}{{scope}}`,
      placeholders: [
        ...CARD,
        { name: "question", description: "调研问题" },
        { name: "scope", description: "查找范围整行（含换行与“查找范围：”），没有则为空" },
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
  ];
}

export type MasterPromptKey =
  | "master.rules"
  | "master.rules_supplement"
  | "master.rules_updated"
  | "master.wake.card_done"
  | "master.repair_json"
  | "master.plan.system"
  | "master.plan.start"
  | "master.plan.turn"
  | "master.plan.research_results"
  | "master.plan.explore"
  | "master.plan.scout"
  | "master.handoff_summary";
