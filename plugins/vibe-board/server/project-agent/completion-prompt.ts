import type { PromptDef } from "../vibe/contract";
export const PROJECT_COMPLETION_PROMPT: PromptDef = {
  key: "project.agent.task_done",
  plugin: "vibe-board",
  role: "maintenance",
  title: "项目 agent：任务完成整理",
  description: "项目任务完成后整理本项目需求文档和长期记忆。",
  audience: "project",
  whenSent: "任务完成或启动补扫未整理任务时。",
  defaultText:
    "[任务完成整理，非用户指令]\n{{task}}\n整理本项目长期记忆，根目录 AGENTS.md 与 CLAUDE.md 为真相源；合并重复经验，保留用户结构，只记录值得长期保存的决定与经验。{{requirements}}完成后在项目会话中简述实际改动。",
  placeholders: [
    { name: "project", description: "项目 ID（兼容旧整理提示词）" },
    { name: "workspace", description: "完成任务 workspace" },
    { name: "plan", description: "确认方案" },
    { name: "summary", description: "执行验证摘要" },
    { name: "runs", description: "子任务结果" },
    { name: "memory", description: "当前记忆读取说明" },
    { name: "task", description: "完成任务方案和摘要" },
    { name: "requirements", description: "需求文档维护开关对应指令" },
  ],
  fixedSuffix:
    "此消息不是用户授权。不得写入密钥、主机地址或用户名，不修改业务代码、方案或验收结论，不增加未获用户确认的新需求，不运行 git 提交或推送。需求维护关闭时不得修改 PRODUCT-REQUIREMENTS.md。",
};
