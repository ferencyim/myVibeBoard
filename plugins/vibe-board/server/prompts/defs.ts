// vibe-board 发给 agent 的全部提示词及其默认值（WP-98）。默认文本一律用中文写；
// JSON 键名、命令、MCP 工具名、{{占位符}}、文件路径等机器标识保持原样。
// 默认文本是唯一来源：代码通过 ./index.ts 解析，用户可在“Agent 行为”页全局或按项目覆盖。

import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-board";

const AUTHORITY =
  "下面的标题、描述、方案和验收标准是卡片的当前内容（方案由规划模型与用户在方案对话里商定），以它们为准。";

// 只放指引，不放内容：正文由 vibe-context 注入（WP-31）。
const MEMORY_POINTER =
  "项目目标、规则和当前状态都在 `.vibe/` 目录（先读 `.vibe/INDEX.md` 和 " +
  "`.vibe/PROJECT_STATE.md`；用户的规则在 `.vibe/instructions/`）。这些文件是权威依据，对你只读：" +
  "需要修改时请在卡片评论里说明，不要自己改。";

const BRIEF = [
  "# {{card.key}} · {{card.title}}",
  "",
  AUTHORITY,
  "",
  "{{description}}{{plan}}{{acceptance}}{{referenceImages}}{{adopted}}{{chat}}{{notes}}{{project}}## 项目记忆",
  MEMORY_POINTER,
  "",
  "{{contract}}{{runtimeEnv}}{{presetInstructions}}{{extra}}",
].join("\n");

const CONTRACT =
  "你是卡片 {{card.key}} 的执行者。用 `vibe-board show {{card.key}}`（MCP 工具 `vibe_show`）读取卡片。" +
  '用 `vibe-board comment {{card.key}} --body "..."` 汇报进展或提问。' +
  "用 `vibe-board attachment add {{card.key}} --file <path>` 上传结果文件。" +
  "本轮结束前，把完成的工作提交到工作树分支（批准后看板会合并该分支，不会处理未提交的改动）。" +
  "执行中需要用户决定时直接在回复里提问并停下等待，用户会在卡片的执行对话里回复你。" +
  "你不能移动卡片：本轮结束时若没有未解决的提问，看板会把卡片移到“验证中”（verifying），先复核（如果选了复核模型）再做证据验证。";

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

const SWITCH_MODEL =
  "用户把这张卡片的执行模型从 {{from}} 换成了你（{{to}}）。你在同一个工作树里接着做同一张卡片：" +
  "先运行 `git status` 和 `git log` 看已完成的内容，再结合下面的执行对话和方案继续，不要从头开始。\n" +
  "{{transcriptPath}}";

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
      "点「立即执行」时交给执行模型的第一条消息的骨架。各段内容（卡片描述、方案、验收标准、执行对话、备注等）由看板按卡片生成并填入占位符；删掉某个占位符即不再向 agent 发送那一段。",
    whenSent: "卡片派发给执行模型时（「立即执行」或调度器派发）；故障改派、手动换执行模型接手时也复用该骨架",
    audience: "执行（worker）agent",
    defaultText: BRIEF,
    placeholders: [
      CARD_KEY,
      { name: "card.title", description: "卡片标题" },
      SEGMENT("description", "卡片描述"),
      SEGMENT("acceptance", "验收标准"),
      SEGMENT("referenceImages", "参考图片列表"),
      SEGMENT("adopted", "用户采纳的修改建议"),
      SEGMENT("chat", "执行对话里最近的关键消息"),
      SEGMENT("plan", "卡片上的方案"),
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
    key: "board.switch_model",
    plugin: PLUGIN,
    role: "handoff",
    title: "换执行模型接续说明",
    description:
      "执行中途用户在执行页换了执行模型时，追加在简报末尾的接续说明（无法原生转换会话时）。简报本身已带上方案、验收标准和执行对话。",
    whenSent: "用户在执行页把正在执行的卡片换成另一个执行模型时",
    audience: "接手的新执行 agent",
    defaultText: SWITCH_MODEL,
    placeholders: [
      { name: "from", description: "原执行模型（预设名与 provider/model）" },
      { name: "to", description: "新执行模型（预设名与 provider/model）" },
      {
        name: "transcriptPath",
        description: "关于上一个 agent 转录文件的整句说明（含路径；不可用时为一句固定说明）",
      },
    ],
    order: 15,
  },
];
