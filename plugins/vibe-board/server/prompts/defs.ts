// Every prompt text vibe-board sends to an agent, registered with its default (WP-98).
// The default text is the single source: code resolves through ./index.ts, the owner may override
// it globally or per project on the Agent behaviour page.

import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-board";

const AUTHORITY =
  "The title, description and acceptance criteria below are the card as it stands now, including every change the owner accepted. They are authoritative: where the plan or hand-off further down says something different, follow the card.";

// Pointers only, never content: vibe-context injects the text itself (WP-31).
const MEMORY_POINTER =
  "Project goals, rules and current state live in `.vibe/` (start with `.vibe/INDEX.md` and " +
  "`.vibe/PROJECT_STATE.md`; owner rules are in `.vibe/instructions/`). These files are " +
  "authoritative and read-only for you: report needed changes in a card comment instead of editing them.";

const BRIEF = [
  "# {{card.key}} · {{card.title}}",
  "",
  AUTHORITY,
  "",
  "{{description}}{{acceptance}}{{referenceImages}}{{handoff}}{{adopted}}{{chat}}{{plan}}{{notes}}{{project}}## Project memory",
  MEMORY_POINTER,
  "",
  "{{contract}}{{runtimeEnv}}{{presetInstructions}}{{extra}}",
].join("\n");

const CONTRACT =
  "You are the worker for card {{card.key}}. Read it with `vibe-board show {{card.key}}` (MCP `vibe_show`). " +
  'Report progress or ask a question with `vibe-board comment {{card.key}} --body "..."`. ' +
  "Attach result files with `vibe-board attachment add {{card.key}} --file <path>`. " +
  "Commit your finished work on the worktree branch before you end the round (the board merges that branch after approval and never touches uncommitted changes). " +
  "You cannot move the card: when your round ends with no open question, the board moves it to verifying.";

const INSTRUCTIONS = `# Vibe Board
Cards live in five columns: draft, todo, in_progress, verifying, done. You work with them through the \`vibe-board\` CLI on your PATH or the \`vibe-board\` MCP tools.
- Read a card: \`vibe-board show ABC-12\` / MCP \`vibe_show\` (description, acceptance criteria, reference images, timeline)
- List cards: \`vibe-board list [--project ABC] [--column todo]\` / MCP \`vibe_list\`
- Create a card (lands in draft): \`vibe-board create --project ABC --title "..."\` / MCP \`vibe_create\`
- Update fields: \`vibe-board update ABC-12 --acceptance "..."\` / MCP \`vibe_update\`
- Report progress or ask questions: \`vibe-board comment ABC-12 --body "..."\` / MCP \`vibe_comment\`
- Attach files: \`vibe-board attachment add ABC-12 --file ./out.png\` / MCP \`vibe_attach\`; fetch: \`vibe-board attachment get <id> --out ./file\`
- Save session progress notes when asked: MCP \`vibe_session_note\` (writes \`.vibe/sessions/<card>.md\` in your worktree, no approval needed)
You cannot move cards between columns; people and the board decide that.`;

const TAKEOVER =
  "The previous agent ({{provider}}) stopped with a {{category}} failure: {{message}}\n" +
  "You are taking over the same card in the SAME worktree: run `git status` and `git log` first to see what is already done, then continue; do not start over.\n" +
  "{{transcriptPath}}";

const NUDGE =
  "The previous agent on {{provider}} stopped ({{category}}). Its history is above; " +
  "continue card {{card.key}} in this worktree (check git status first).";

const WATCHDOG =
  "The board noticed no output from you for a while. Continue the task from where you stopped; " +
  "if you are blocked, say what blocks you with a card comment.";

const SCOUT_SYSTEM = `[vibe-scout]
You are a read-only scout working for another coding agent. Answer ONE question about the repository in your working directory.
- Never modify files, never run commands that change state, never call vibe_scout or any vibe_* tool.
- Be fast: search and read only what the question needs.
- Reply with at most {{maxLines}} lines of plain text, no preamble. Every finding is one line "path:line - what it is" (relative paths). Say explicitly when something was not found.`;

const SCOUT_TASK =
  "Kind: {{kind}}. {{how}}\n" +
  "Goal: {{goal}}\n" +
  "{{restrict}}Answer in at most {{maxLines}} lines with path:line anchors.";

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
      "简报中的“Report-back contract”段正文：告诉 agent 如何读卡、汇报、提交。这是看板流程约定而非解析格式，可以编辑；修改文字不改变看板行为，请保持与实际一致。",
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
      "The scheduler reserved dev-server port {{port}} for this task. Run any dev server on that port so parallel tasks do not collide.",
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
      { name: "restrict", description: "限定路径整行（“Restrict to: …”并带换行）；未限定时为空" },
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
    defaultText: "Locate the files, symbols or lines that answer the goal.",
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
    defaultText: "Make a precise inventory (counts, lists) for the goal; give exact numbers.",
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
      "Research the goal from the repository docs, comments and sources (and the web if you have a search tool).",
    order: 32,
  },
];
