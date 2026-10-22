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
  "{{description}}{{plan}}{{subtasks}}{{acceptance}}{{referenceImages}}{{adopted}}{{chat}}{{notes}}{{project}}## 项目记忆",
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

const ORCHESTRATE = `你是卡片 {{card.key}} 的主代理（总执行代理）。方案把工作拆成了下面的子任务，每个子任务交给一个独立的子代理完成，你负责统筹：
- 先用 MCP 工具 \`vibe_subtask_status\`（参数 key = {{card.key}}）查看子任务和状态，按依赖关系决定先后，没有依赖、涉及文件不重叠的可以并行。
- 用 \`vibe_subtask_start\` 请看板启动某个子任务的子代理（可以附加补充说明）。依赖未完成、涉及文件与正在运行的子任务有交集、或超出并发上限时，看板会拒绝并告诉你原因：等相关子代理结束后再启动。
- 所有子代理和你共用同一个工作树；不要自己修改正在由子代理处理的文件。
- 子代理完成、失败或提问时，看板会给你发一条以 [子任务通知] 开头的消息。子代理的提问先由你用 \`vibe_subtask_message\` 回答；你也答不了，就在回复里直接问用户并停下等待。
- 子代理失败时可以再次 \`vibe_subtask_start\`，或用 \`vibe_subtask_mark\` 标记为你自己完成/放弃并写明原因。
- 启动子代理后就可以结束本轮回复，等通知再继续，不需要轮询；还有子代理在运行时，你结束回复不会让卡片进入验证。
- 全部子任务完成后，检查整体结果是否满足卡片的验收标准，补上整合、测试与提交，最后写一段总结结束本轮。
- 很小的子任务也可以你自己直接做，做完用 \`vibe_subtask_mark\` 标记完成。`;

const SUBTASK_BRIEF = `# {{card.key}} · 子任务 {{subtask.id}}：{{subtask.title}}

你是卡片 {{card.key}}「{{card.title}}」的子代理，只负责下面这一个子任务。卡片由主代理统筹，其它子任务可能由别的子代理同时进行，大家共用同一个工作树。

## 目标
{{goal}}

## 方法
{{method}}

## 注意事项
{{notes}}

## 验收标准
{{acceptance}}

## 涉及文件
{{files}}
只改与本子任务有关的文件；确实需要改其它文件时，先在回复里说明理由并停下等待。

{{description}}{{plan}}{{extra}}## 回报约定
- 不要移动卡片，不要启动其它代理，不要改动别的子任务负责的文件。
- 需要决定时直接在回复里提问并停下等待，主代理会回答你。
- 完成后把你的改动提交到当前工作树分支（只提交你改的文件），最后用几句话总结：做了什么、怎么验证的、还有什么遗留。`;

const SUBTASK_NOTIFY = `[子任务通知] 卡片 {{card.key}}
{{updates}}

当前各子任务状态：
{{overview}}

请据此继续统筹：回答子代理的提问（vibe_subtask_message）、启动可以开始的子任务（vibe_subtask_start），或在全部完成后整合、验证并总结。`;

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
      SEGMENT("subtasks", "方案里的子任务与主代理统筹说明（来自“主代理统筹说明”提示词；方案没有子任务时为空）"),
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
    key: "board.orchestrate",
    plugin: PLUGIN,
    role: "executor",
    title: "主代理统筹说明",
    description:
      "方案里有子任务时，派发简报“子任务”段开头的说明：告诉主代理如何用看板的 vibe_subtask_* 工具启动子代理、等待通知、回答子代理提问和收尾。后面紧跟全部子任务（由看板生成）。",
    whenSent: "派发给主代理时（方案有子任务）；换主代理模型、故障改派接手时同样带上",
    audience: "主代理（执行 worker）",
    defaultText: ORCHESTRATE,
    placeholders: [CARD_KEY],
    order: 25,
  },
  {
    key: "board.subtask_brief",
    plugin: PLUGIN,
    role: "executor",
    title: "子代理任务简报",
    description:
      "主代理请看板启动某个子任务时，交给该子代理的第一条消息：子任务的目标、方法、注意事项、验收标准、涉及文件，以及卡片描述与方案作为背景。",
    whenSent: "主代理调用 vibe_subtask_start、看板放行后；子代理故障改派时新子代理也收到它",
    audience: "子代理",
    defaultText: SUBTASK_BRIEF,
    placeholders: [
      CARD_KEY,
      { name: "card.title", description: "卡片标题" },
      { name: "subtask.id", description: "子任务编号，如 s1" },
      { name: "subtask.title", description: "子任务标题" },
      { name: "goal", description: "子任务目标（空时为“无。”）" },
      { name: "method", description: "子任务方法（空时为“无。”）" },
      { name: "notes", description: "注意事项（空时为“无。”）" },
      { name: "acceptance", description: "子任务验收标准（空时为“无。”）" },
      { name: "files", description: "涉及文件列表（每行一个）" },
      SEGMENT("description", "卡片描述"),
      SEGMENT("plan", "卡片方案全文（背景）"),
      SEGMENT("extra", "主代理启动时的补充说明"),
    ],
    order: 26,
  },
  {
    key: "board.subtask_notify",
    plugin: PLUGIN,
    role: "executor",
    title: "子任务通知（发给主代理）",
    description:
      "子代理完成、失败或提问时看板发给主代理的消息；几件事同时发生时合成一条。主代理在等用户回答时暂不发送，回答后再补发。",
    whenSent: "子代理一轮结束、失败（含改派失败）、提问或会话丢失时",
    audience: "主代理（执行 worker）",
    defaultText: SUBTASK_NOTIFY,
    placeholders: [
      CARD_KEY,
      { name: "updates", description: "这次的状态变化，每个子任务一行（含小结、失败原因或提问内容）" },
      { name: "overview", description: "全部子任务当前状态，每行一个" },
    ],
    order: 27,
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
