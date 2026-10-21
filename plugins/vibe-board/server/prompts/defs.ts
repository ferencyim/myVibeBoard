// vibe-board 发给 agent 的全部提示词及其默认值（WP-98）。默认文本一律用中文写；
// JSON 键名、命令、MCP 工具名、{{占位符}}、文件路径等机器标识保持原样。
// 默认文本是唯一来源：代码通过 ./index.ts 解析，主人可在“Agent 行为”页全局或按项目覆盖。

import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-board";

const AUTHORITY =
  "下面的标题、描述和验收标准是卡片的当前内容，已包含主人采纳的全部改动，以它们为准：后文的计划或交接内容与之不一致时，按卡片执行。";

// 只放指引，不放内容：正文由 vibe-context 注入（WP-31）。
const MEMORY_POINTER =
  "项目目标、规则和当前状态都在 `.vibe/` 目录（先读 `.vibe/INDEX.md` 和 " +
  "`.vibe/PROJECT_STATE.md`；主人的规则在 `.vibe/instructions/`）。这些文件是权威依据，对你只读：" +
  "需要修改时请在卡片评论里说明，不要自己改。";

const BRIEF = [
  "# {{card.key}} · {{card.title}}",
  "",
  AUTHORITY,
  "",
  "{{description}}{{acceptance}}{{referenceImages}}{{handoff}}{{adopted}}{{chat}}{{plan}}{{notes}}{{project}}## 项目记忆",
  MEMORY_POINTER,
  "",
  "{{contract}}{{runtimeEnv}}{{presetInstructions}}{{extra}}",
].join("\n");

const CONTRACT =
  "你是卡片 {{card.key}} 的执行者。用 `vibe-board show {{card.key}}`（MCP 工具 `vibe_show`）读取卡片。" +
  '用 `vibe-board comment {{card.key}} --body "..."` 汇报进展或提问。' +
  "用 `vibe-board attachment add {{card.key}} --file <path>` 上传结果文件。" +
  "本轮结束前，把完成的工作提交到工作树分支（批准后看板会合并该分支，不会处理未提交的改动）。" +
  "你不能移动卡片：本轮结束时若没有未解决的提问，看板会把卡片移到“验证中”（verifying）。";

const INSTRUCTIONS = `# Vibe Board
卡片分五列：draft（草稿）、todo（待办）、in_progress（进行中）、verifying（验证中）、done（完成）。通过 PATH 上的 \`vibe-board\` 命令行或 \`vibe-board\` MCP 工具操作卡片。
- 读卡片：\`vibe-board show ABC-12\` / MCP \`vibe_show\`（描述、验收标准、参考图片、时间线）
- 列卡片：\`vibe-board list [--project ABC] [--column todo]\` / MCP \`vibe_list\`
- 创建卡片（进入 draft）：\`vibe-board create --project ABC --title "..."\` / MCP \`vibe_create\`
- 更新字段：\`vibe-board update ABC-12 --acceptance "..."\` / MCP \`vibe_update\`
- 汇报进展或提问：\`vibe-board comment ABC-12 --body "..."\` / MCP \`vibe_comment\`
- 附件：\`vibe-board attachment add ABC-12 --file ./out.png\` / MCP \`vibe_attach\`；下载：\`vibe-board attachment get <id> --out ./file\`
- 被要求时保存会话进度笔记：MCP \`vibe_session_note\`（写入你工作树里的 \`.vibe/sessions/<card>.md\`，无需批准）
你不能在列之间移动卡片，由人和看板决定。`;

const TAKEOVER =
  "上一个 agent（{{provider}}）因 {{category}} 故障停止：{{message}}\n" +
  "你在同一个工作树里接手同一张卡片：先运行 `git status` 和 `git log` 查看已完成的内容，然后继续，不要从头开始。\n" +
  "{{transcriptPath}}";

const NUDGE =
  "{{provider}} 上的上一个 agent 已停止（{{category}}）。它的历史记录在上方；" +
  "请在本工作树继续卡片 {{card.key}}（先检查 git status）。";

const WATCHDOG =
  "看板发现你已有一段时间没有输出。请从停下的地方继续任务；" +
  "如果被卡住了，请用卡片评论说明卡在哪里。";

const SCOUT_SYSTEM = `[vibe-scout]
你是为另一个编码 agent 服务的只读探路兵。只回答关于你工作目录中仓库的一个问题。
- 不要修改文件，不要运行会改变状态的命令，不要调用 vibe_scout 或任何 vibe_* 工具。
- 动作要快：只搜索、阅读问题需要的内容。
- 回复为纯文本，最多 {{maxLines}} 行，不要开场白。每条发现占一行，格式为“path:line - 说明”（用相对路径）。没找到的内容要明确说没找到。`;

const SCOUT_TASK =
  "类型：{{kind}}。{{how}}\n" +
  "目标：{{goal}}\n" +
  "{{restrict}}回复最多 {{maxLines}} 行，并带 path:line 定位。";

const CARD_KEY = { name: "card.key", description: "卡片编号，如 ABC-12" };
const SEGMENT = (name: string, description: string) => ({
  name,
  description: `${description}（自带“## 标题”与段尾空行；无内容时为空）`,
});

export const BOARD_PROMPT_DEFS: readonly PromptDef[] = [
  {
    key: "board.brief",
    plugin: PLUGIN,
    role: "executor",
    title: "派发任务简报",
    description:
      "派发或改派卡片时交给执行 agent 的第一条消息的骨架。各段内容（卡片描述、验收标准、计划、备注等）由看板按卡片生成并填入占位符；删掉某个占位符即不再向 agent 发送那一段。",
    whenSent: "卡片从“待办”派发给执行 agent 时；故障改派接手时也复用该骨架",
    audience: "执行（worker）agent",
    defaultText: BRIEF,
    placeholders: [
      CARD_KEY,
      { name: "card.title", description: "卡片标题" },
      SEGMENT("description", "卡片描述"),
      SEGMENT("acceptance", "验收标准"),
      SEGMENT("referenceImages", "参考图片列表"),
      SEGMENT("handoff", "规划会话的交接摘要"),
      SEGMENT("adopted", "已采纳的主控建议"),
      SEGMENT("chat", "群聊中最近的主人/主控消息"),
      SEGMENT("plan", "最新计划与检查项"),
      SEGMENT("notes", "最近的备注、驳回与评估"),
      SEGMENT("project", "项目名称与类型"),
      SEGMENT("contract", "回报约定（来自“回报约定”提示词）"),
      SEGMENT("runtimeEnv", "预设的运行环境"),
      SEGMENT("presetInstructions", "预设的附加指令"),
      SEGMENT("extra", "本次派发的额外指令（端口预留、接手说明等）"),
    ],
    order: 10,
  },
  {
    key: "board.brief_contract",
    plugin: PLUGIN,
    role: "executor",
    title: "回报约定",
    description:
      "简报中的“回报约定”段正文：告诉 agent 如何读卡、汇报、提交。这是看板流程约定而非解析格式，可以编辑；修改文字不改变看板行为，请保持与实际一致。",
    whenSent: "随派发任务简报一起发送",
    audience: "执行（worker）agent",
    defaultText: CONTRACT,
    placeholders: [CARD_KEY],
    order: 20,
  },
  {
    key: "board.port_hint",
    plugin: PLUGIN,
    role: "executor",
    title: "开发端口提示",
    description: "调度器为任务预留了开发服务器端口时，追加在简报末尾的说明。",
    whenSent: "调度器放行并预留端口后派发时",
    audience: "执行（worker）agent",
    defaultText:
      "调度器为本任务预留了开发服务器端口 {{port}}。需要启动开发服务器时请使用该端口，避免并行任务冲突。",
    placeholders: [{ name: "port", description: "预留的端口号" }],
    order: 30,
  },
  {
    key: "board.instructions",
    plugin: PLUGIN,
    role: "executor",
    title: "看板使用说明",
    description:
      "注入到 agent 系统提示词里的看板说明（命令行与 MCP 工具用法）。开头的 [vibe-board] 标记由程序固定添加，用于避免重复注入，不在此处编辑。",
    whenSent: "任何 agent 创建时（设置中开启“自动注入说明”）",
    audience: "所有被看板注入的 agent",
    defaultText: INSTRUCTIONS,
    order: 40,
  },
  {
    key: "board.takeover",
    plugin: PLUGIN,
    role: "handoff",
    title: "改派接手说明",
    description: "故障改派（无法原生转换会话）时追加在简报末尾的接手说明。",
    whenSent: "执行 agent 因额度/登录/服务商错误停止，改派给备用预设时",
    audience: "接手的新 agent",
    defaultText: TAKEOVER,
    placeholders: [
      { name: "provider", description: "上一个 agent 的服务商" },
      { name: "category", description: "故障类别" },
      { name: "message", description: "故障信息" },
      {
        name: "transcriptPath",
        description: "关于上一个 agent 转录文件的整句说明（含路径；不可用时为一句固定说明）",
      },
    ],
    order: 10,
  },
  {
    key: "board.takeover_nudge",
    plugin: PLUGIN,
    role: "handoff",
    title: "改派后催促继续",
    description: "会话被原生转换给新服务商后，发给新 agent 的第一条消息（它没有自己的提示词）。",
    whenSent: "故障改派并完成会话转换后",
    audience: "接手的新 agent",
    defaultText: NUDGE,
    placeholders: [
      { name: "provider", description: "上一个 agent 的服务商" },
      { name: "category", description: "故障类别" },
      CARD_KEY,
    ],
    order: 20,
  },
  {
    key: "board.watchdog_continue",
    plugin: PLUGIN,
    role: "watchdog",
    title: "卡住后催促继续",
    description: "agent 长时间无输出并被中断后发送的“继续”提示。",
    whenSent: "卡住检测触发自动中断时（设置中开启）",
    audience: "被判定卡住的 agent",
    defaultText: WATCHDOG,
    order: 10,
  },
  {
    key: "board.scout_system",
    plugin: PLUGIN,
    role: "scout",
    title: "探路兵系统提示词",
    description: "探路兵（只读子 agent）的系统提示词。",
    whenSent: "执行 agent 调用 vibe_scout 并创建探路兵时",
    audience: "探路兵 agent",
    defaultText: SCOUT_SYSTEM,
    placeholders: [{ name: "maxLines", description: "回复的最大行数（来自设置）" }],
    order: 10,
  },
  {
    key: "board.scout_task",
    plugin: PLUGIN,
    role: "scout",
    title: "探路兵任务提示",
    description: "发给每个探路兵的任务消息骨架。",
    whenSent: "执行 agent 调用 vibe_scout 时，每个子任务一条",
    audience: "探路兵 agent",
    defaultText: SCOUT_TASK,
    placeholders: [
      { name: "kind", description: "任务类型（locate / inventory / research）" },
      { name: "how", description: "按任务类型取的做法说明" },
      { name: "goal", description: "任务目标" },
      { name: "restrict", description: "限定路径整行（“限定范围：…”并带换行）；未限定时为空" },
      { name: "maxLines", description: "回复的最大行数（来自设置）" },
    ],
    order: 20,
  },
  {
    key: "board.scout_how.locate",
    plugin: PLUGIN,
    role: "scout",
    title: "探路做法：定位",
    description: "任务类型为 locate 时的做法说明。",
    whenSent: "探路任务类型为 locate 时",
    audience: "探路兵 agent",
    defaultText: "定位能回答目标的文件、符号或代码行。",
    order: 30,
  },
  {
    key: "board.scout_how.inventory",
    plugin: PLUGIN,
    role: "scout",
    title: "探路做法：清点",
    description: "任务类型为 inventory 时的做法说明。",
    whenSent: "探路任务类型为 inventory 时",
    audience: "探路兵 agent",
    defaultText: "针对目标做精确清点（数量、清单），给出准确数字。",
    order: 31,
  },
  {
    key: "board.scout_how.research",
    plugin: PLUGIN,
    role: "scout",
    title: "探路做法：调研",
    description: "任务类型为 research 时的做法说明。",
    whenSent: "探路任务类型为 research 时",
    audience: "探路兵 agent",
    defaultText:
      "从仓库文档、注释和源码调研目标（如果有搜索工具，也可以查网络）。",
    order: 32,
  },
];
