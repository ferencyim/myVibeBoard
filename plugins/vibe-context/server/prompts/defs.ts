// vibe-context 发给 agent 或注入其上下文的全部提示词及其默认值（WP-99）。默认文本一律用中文写；
// 命令（如 /compact）、MCP 工具名、{{占位符}}、文件路径保持原样。代码通过 ./index.ts 解析，
// 用户可在“Agent 行为”页全局或按项目覆盖。这里的文本都不从回复里解析，所以没有 fixedSuffix。

import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-context";

const COMPACT_NOTES =
  "你的上下文即将被压缩。压缩之前，请先保存进度笔记：目标、已完成的、进行中的、下一步、" +
  "关键文件与决策、未解决的问题。" +
  "使用 `vibe-board` MCP 服务的 `vibe_session_note` 工具{{keyClause}}（它会覆盖写入 " +
  "`{{mdPath}}`，无需批准）；只有该工具不存在时，才自己写这个文件" +
  '（创建或覆盖）。除此之外什么都不要做。完成后回复“saved”。';

const COMPACT_RESTORE =
  "上下文已压缩。下面的项目上下文是权威依据；请根据你的会话笔记继续。" +
  '只回复“ok”。\n\n{{block}}';

const COLD_START =
  "你接续会话 {{oldSessionId}}：它因为上下文变长或缓存即将过期而被交接。" +
  "先读 `{{mdPath}}` 了解它的进度，再读 `.vibe/` 下的文件了解项目记忆，" +
  "然后继续完成任务。{{block}}";

const INJECT_FRAME =
  "# 项目上下文（myVibeBoard）\n\n" +
  "以下内容在本会话启动时由 `.vibe/` 下的文件生成，是权威依据，对你只读：" +
  "不要编辑这些文件；需要更正时告知总 agent（看板任务则写在卡片评论里）。";

const SCOUT_GUIDANCE =
  "## 探路（`vibe_scout` 工具可用时）\n" +
  "在大型仓库里动手修改前，先用几个互相独立的问题调用一次 `vibe_scout`" +
  "（`kind`：locate / inventory / research），让便宜的只读子 agent 并行搜索；你拿到的是" +
  "带 path:line 定位的简短结论，不必自己通读一遍。适合：在陌生仓库里定位代码、" +
  "批量统计/列出用法、从多处收集事实。" +
  "只改一两个已知文件的小改动不必使用。依赖某个定位之前，先核对它，再动手修改。";

export const CONTEXT_PROMPT_DEFS: readonly PromptDef[] = [
  {
    key: "context.compact_notes",
    plugin: PLUGIN,
    role: "context",
    title: "压缩前：保存进度笔记",
    description:
      "会话的缓存快过期、即将压缩（或交接）之前，要求 agent 把进度笔记写进会话笔记文件。回复内容不会被解析。",
    whenSent: "会话空闲且提示缓存即将过期（或会话被判为“长对话”）时，压缩之前",
    audience: "被压缩的 agent",
    defaultText: COMPACT_NOTES,
    placeholders: [
      { name: "keyClause", description: "有卡片时为 `，key 为 \"ABC-1\"`，否则为空" },
      { name: "mdPath", description: "会话笔记文件路径" },
    ],
    order: 10,
  },
  {
    key: "context.compact_restore",
    plugin: PLUGIN,
    role: "context",
    title: "压缩后：恢复项目上下文",
    description: "压缩完成后重新交给 agent 的项目上下文块，并要求它按会话笔记继续。",
    whenSent: "压缩命令完成后",
    audience: "刚被压缩的 agent",
    defaultText: COMPACT_RESTORE,
    placeholders: [{ name: "block", description: "项目上下文块（项目目标与状态）；没有时为“（无项目上下文）”" }],
    order: 20,
  },
  {
    key: "context.cold_start",
    plugin: PLUGIN,
    role: "handoff",
    title: "冷启动交接",
    description:
      "不支持压缩命令的 provider（或长对话多次压缩后），把任务交给全新 agent 时的第一条消息。",
    whenSent: "创建接手的新 agent 时",
    audience: "接手的新 agent",
    defaultText: COLD_START,
    placeholders: [
      { name: "oldSessionId", description: "被替换会话的 id" },
      { name: "mdPath", description: "会话笔记文件路径" },
      { name: "block", description: "项目上下文块（自带前置空行；没有时为空）" },
    ],
    order: 10,
  },
  {
    key: "context.inject_frame",
    plugin: PLUGIN,
    role: "context",
    title: "注入上下文块：说明文字",
    description:
      "新 agent 创建时注入的“项目上下文”块的开头说明。块的起止标记、用户指令、项目指令与项目记忆由程序按 .vibe/ 文件生成，不在此处编辑。",
    whenSent: "任何带有 .vibe/ 目录的项目里创建 agent 时（注入系统提示或 AGENTS 文件）",
    audience: "所有在项目中工作的 agent",
    defaultText: INJECT_FRAME,
    order: 30,
  },
  {
    key: "context.scout_guidance",
    plugin: PLUGIN,
    role: "context",
    title: "注入上下文块：探路兵使用建议",
    description: "注入块里关于何时使用 vibe_scout 并行探路的建议（仅在该工具可用时有意义）。",
    whenSent: "与上下文块一起注入",
    audience: "所有在项目中工作的 agent",
    defaultText: SCOUT_GUIDANCE,
    order: 40,
  },
];
