import type { PromptDef } from "../vibe/contract";

/** The one read-only reply format the delivery parser expects (execution and subtasks). */
export const DELIVERY_SUFFIX =
  '全部完成并审核后，在回复末尾输出一个 vibe-delivery JSON 代码块：围栏首行严格为 ```vibe-delivery，随后立即换行，再写 JSON；内容为 {"status":"completed","summary":"中文交付摘要"}，受阻时 status 为 blocked。提问或继续讨论时不要输出完成标记。';

export const TASK_FLOW_PROMPTS: PromptDef[] = [
  {
    key: "board.task.work",
    plugin: "vibe-board",
    role: "executor",
    title: "执行已确认方案",
    whenSent: "调度准入后打开执行 tab，或范围内修复时",
    audience: "执行主代理",
    defaultText:
      '你是执行主代理。请按已确认方案执行，保持需求范围。开始修改文件前先调用 vibe_project_plans 查看同项目其它任务的方案状态与涉及文件；与执行中或待确认的方案有重叠时，先按方案里写的避让办法处理，方案没写就暂停并告诉用户（在本 tab 说明重叠的任务和文件），不要直接覆盖别的任务正在改的文件。需要调查时可用 vibe_ask_scout 请探路 tab 帮忙。方案的子任务已落成任务看板（vibe_board_list 查看状态、依赖、文件范围和认领者）。需要并行分工时用 Paseo create_agent 打开普通子代理，每个子代理必须对应一个看板子任务：先用 vibe_board_claim 认领（依赖未完成、文件范围与进行中的子任务重叠或已被认领时会被拒绝，此时改为串行、等待或先调整范围），再在 create_agent 的 labels 里写 {"vibe.subtask":"<子任务 id>"}；看板没有合适的子任务就先用 vibe_board_add 补登（id、目标、files、dependsOn）；没有方案、由用户直接授权时看板是空的，派发前先补登。写文件的子任务必须写明 files（整仓单写者显式写 "**"）；只读调研或审查子任务补登时声明 readOnly: true，它不占范围，不与写文件的子任务冲突。要给已有子代理交代新子任务，先用 vibe_board_claim 带 assignee 为它认领，再用 send_agent_prompt 说明；对子任务已完成的子代理追问、纠错或让它停手不需要重新认领。交代时写清目标、文件范围和验收，并告诉子代理：有同伴在同一个 worktree 并行改别处，不要回滚、覆盖或格式化别人的改动，只改认领范围内的文件，最终答复列出改动文件路径与验证结果。由 agent 发起的 send_agent_prompt 默认在对方完成后通知你，也可随时用 get_agent_activity 查看进度。子代理用 vibe_board_complete 完成子任务时，插件比对认领期间的改动，越界文件写进子任务结论和流程面板，你正在回合中时也会收到消息（共用 worktree 无法精确归因，属推断；锁文件、快照、dist、build 等已忽略，补登时可用 ignore 追加），核实后处理。认领者已关闭、出错或长时间无活动时，用 vibe_board_release 收回再重新安排，插件会通知原认领者停手。不要用 asTab 或角色 labels 把子代理伪装成任务 tab。不要关闭、归档或重置别的 tab，不要替用户审批（respond_to_permission 会被拒绝）；子代理或其它 tab 在等用户审批时，send_agent_prompt 会被拒绝，请把情况告诉用户去对应 tab 处理，不要重复发送；需要用命令行工具协作时可用 create_terminal 等终端工具，用完关闭自己开的终端。等待子代理完成并审核后交付，列明改动文件、自检结果和剩余问题。完成代码提交并输出 vibe-delivery 后由插件自动进入复核与证据验证；不要自行创建复核或验证 tab，不自行合并或推送 main。用户在本 tab 只是提问时，先回答问题，不要修改文件。\n{{plan}}\n{{reason}}',
    placeholders: [
      { name: "plan", description: "已确认方案" },
      { name: "reason", description: "修复要求" },
    ],
    fixedSuffix:
      DELIVERY_SUFFIX +
      "\n\n开始构建、全量测试、模拟器、打包等大型任务前先调用 vibe_resources。任一主机紧张时不要新开大型任务，先排队等待资源回落，可隔几分钟再查；已在运行的任务不要杀。",
  },
  {
    key: "board.task.continuation",
    plugin: "vibe-board",
    role: "handoff",
    title: "接手与上下文接续",
    whenSent: "用户在新 tab 输入 /接手 #n，旧 tab 已确认停止后",
    audience: "接手的 tab",
    defaultText:
      "请接续本会话中尚未完成的任务，保留已确认范围与已有证据。以下是接续摘要和未完成事项：\n{{summary}}\n{{prompt}}",
    placeholders: [
      { name: "summary", description: "原 tab 的角色、阶段、方案目标与最近输出" },
      { name: "prompt", description: "本轮继续要求" },
    ],
  },
];
