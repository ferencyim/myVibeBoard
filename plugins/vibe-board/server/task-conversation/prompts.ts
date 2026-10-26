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
      "你是执行主代理。请按已确认方案执行，保持需求范围。需要并行调查或分工时，可用 Paseo create_agent 打开普通子代理，用 send_agent_prompt 说明目标、文件范围和验收（由 agent 发起时默认在对方完成后通知你，也可随时用 get_agent_activity 查看进度）；不要用 labels 或 asTab 把子代理伪装成任务 tab，同一文件的写入不能并行。等待子代理完成并审核后交付，列明改动、自检结果和剩余问题。完成代码提交并输出 vibe-delivery 后由插件自动进入复核与证据验证；不要自行创建复核或验证 tab，不自行合并或推送 main。用户在本 tab 只是提问时，先回答问题，不要修改文件。\n{{plan}}\n{{reason}}",
    placeholders: [
      { name: "plan", description: "已确认方案" },
      { name: "reason", description: "修复要求" },
    ],
    fixedSuffix: DELIVERY_SUFFIX,
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
