import { TASK_PLAN_PROMPT, type PromptDef } from "../vibe/contract";

export const TASK_FLOW_PROMPTS: PromptDef[] = [
  {
    key: "board.task.plan",
    plugin: "vibe-board",
    role: "planner",
    title: "任务制定与修改方案",
    whenSent: "制定方案或根据探路、方案复核结论修改时",
    audience: "规划成员",
    defaultText:
      "请根据本会话的公开需求、限制和已有结论制定或修改完整方案。发现歧义先向用户提问，不执行代码修改。{{reason}}",
    placeholders: [{ name: "reason", description: "本轮补充要求或复核结论" }],
    fixedSuffix: TASK_PLAN_PROMPT.fixedSuffix,
  },
  {
    key: "board.task.scout",
    plugin: "vibe-board",
    role: "scout",
    title: "任务只读探路",
    whenSent: "规划阶段启用探路时",
    audience: "探路成员",
    defaultText:
      "请只读检查本任务的相关文件、约束和验证入口，给规划成员简洁的定位与风险结论。不要修改文件，不要执行写入命令，不制定执行授权。\n本轮要求：{{reason}}",
    placeholders: [{ name: "reason", description: "用户制定或修改方案的要求" }],
  },
  {
    key: "board.task.plan_review",
    plugin: "vibe-board",
    role: "reviewer",
    title: "任务方案复核",
    whenSent: "用户请求复核方案时",
    audience: "方案复核成员",
    defaultText:
      "请只读复核以下完整方案是否满足本会话的需求、限制及验收条件。说明必要修改和原因，不修改文件。\n{{plan}}",
    placeholders: [{ name: "plan", description: "最新完整规划源" }],
  },
  {
    key: "board.task.work",
    plugin: "vibe-board",
    role: "executor",
    title: "已确认任务执行",
    whenSent: "调度准入或范围内修复时",
    audience: "执行主代理",
    defaultText:
      "请按已确认方案执行，保持需求范围。需要并行调查或分工时，可用 Paseo create_agent 打开普通子代理，用 send_agent_prompt 说明目标、文件范围和验收（由 agent 发起时默认在对方完成后通知你，也可随时用 get_agent_activity 查看进度）；不要用 labels 或 asTab 把子代理伪装成任务 tab，同一文件的写入不能并行。等待子代理完成并审核后交付，列明改动、自检结果和剩余问题。完成代码提交并输出 vibe-delivery 后由插件自动进入复核与证据验证；不要自行创建复核或验证 tab，不自行合并或推送 main。\n{{plan}}\n{{reason}}",
    placeholders: [
      { name: "plan", description: "已确认方案" },
      { name: "reason", description: "修复要求" },
    ],
    fixedSuffix:
      '全部完成并审核后，在回复末尾输出一个 vibe-delivery JSON 代码块，内容为 {"status":"completed","summary":"中文交付摘要"}；受阻时 status 为 blocked。提问或继续讨论时不要输出完成标记。',
  },
  {
    key: "board.task.subtask",
    plugin: "vibe-board",
    role: "executor",
    title: "已登记子任务执行",
    whenSent: "主代理委派已确认子任务时",
    audience: "执行子代理",
    defaultText:
      "请只执行以下已确认子任务，遵守目标、方法、注意事项、文件范围和验收标准，不扩大范围。完成后报告证据并把控制交回主代理。\n{{subtask}}",
    placeholders: [{ name: "subtask", description: "冻结方案中的子任务" }],
    fixedSuffix:
      '完成时在回复末尾输出一个 vibe-delivery JSON 代码块，内容为 {"status":"completed","summary":"中文交付摘要"}；受阻时 status 为 blocked。未完成不能输出 completed。',
  },
  {
    key: "board.task.continuation",
    plugin: "vibe-board",
    role: "handoff",
    title: "任务失败与上下文接续",
    whenSent: "旧成员已确认停止且新成员重新准入后",
    audience: "替代成员",
    defaultText:
      "请接续本会话中尚未完成的任务，保留已确认范围与已有证据。以下是接续摘要和未完成事项：\n{{summary}}\n{{prompt}}",
    placeholders: [
      { name: "summary", description: "原成员接续摘要" },
      { name: "prompt", description: "本轮继续要求" },
    ],
  },
];
