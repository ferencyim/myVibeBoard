// Every prompt text vibe-context sends to an agent or injects into its context, registered with its
// default (WP-99). Code resolves through ./index.ts; the owner may override a text globally or per
// project on the Agent behaviour page. Nothing here is parsed from a reply, so there are no fixed suffixes.

import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-context";

const COMPACT_NOTES =
  "Your context is about to be compacted. Before that, save your progress notes: the goal, " +
  "what is done, what is in progress, next steps, key files and decisions, open questions. " +
  "Use the `vibe_session_note` tool of the `vibe-board` MCP server{{keyClause}} (it overwrites " +
  "`{{mdPath}}` and needs no approval); only if that tool does not exist, write that file " +
  'yourself (create or overwrite it). Do nothing else. Reply "saved" when done.';

const COMPACT_RESTORE =
  "Context was compacted. The project context below is authoritative; continue from your " +
  'session notes. Reply "ok" only.\n\n{{block}}';

const COLD_START =
  "You continue session {{oldSessionId}}, handed over because its context grew long or its cache expires. " +
  "Read `{{mdPath}}` for its progress and the files under `.vibe/` for project memory, " +
  "then carry on with the task.{{block}}";

const INJECT_FRAME =
  "# Project context (myVibeBoard)\n\n" +
  "Generated from the files under `.vibe/` when this session started. It is authoritative and " +
  "read-only for you: never edit these files; report needed corrections to the master agent " +
  "(for a board task, in a card comment).";

const SCOUT_GUIDANCE =
  "## Scouting (if the `vibe_scout` tool is available)\n" +
  "Before editing in a large repo, call `vibe_scout` once with several independent questions " +
  "(`kind`: locate / inventory / research) so cheap read-only sub-agents search in parallel; you get back " +
  "short findings with path:line anchors instead of reading everything yourself. Good for: locating code " +
  "in an unfamiliar repo, counting/listing usages in bulk, gathering facts from several sources. " +
  "Skip it for a small change in one or two known files. Verify anchors you rely on before editing.";

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
      { name: "keyClause", description: "有卡片时为 ` with key \"ABC-1\"`，否则为空" },
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
    placeholders: [{ name: "block", description: "项目上下文块（项目目标与状态）；没有时为“(no project context)”" }],
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
