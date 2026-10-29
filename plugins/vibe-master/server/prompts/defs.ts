// Every prompt text vibe-master sends, registered in the shared prompt registry (WP-98). The
// defaults live here and only here; the owner overrides them globally or per project on the
// "Agent behaviour" page. `fixedSuffix` carries the reply format the parsers expect, so a
// customised body can never break the JSON handling.

import { MASTER_RULES } from "../master/rules.generated";
import type { PromptDef } from "../vibe/contract";

const PLUGIN = "vibe-master";

export interface MasterDefOptions {
  /** Base rules text (default: the SKILL.md rules). */
  rules?: string;
}

export function masterPromptDefs(options: MasterDefOptions = {}): PromptDef[] {
  return [
    {
      key: "master.rules",
      plugin: PLUGIN,
      role: "master",
      title: "系统规则",
      description:
        "总 agent 的系统提示正文（默认来自 skills/vibe-master/SKILL.md）。可整篇覆盖，恢复默认即回到 SKILL 生成的规则。覆盖后，运行中的总 agent 会在下一条消息里收到完整新规则。",
      whenSent:
        "总 agent 创建时作为系统提示；provider 不支持系统提示时随首条消息发送；规则文本变化后在下一条消息重发。",
      audience: "总 agent",
      defaultText: options.rules ?? MASTER_RULES,
      placeholders: [],
      order: 0,
    },
    {
      key: "master.rules_supplement",
      plugin: PLUGIN,
      role: "master",
      title: "规则补充",
      description: "追加在系统规则之后的补充规则，与系统规则正文分开维护。留空表示没有补充。",
      whenSent: "与系统规则一起发送（附在其后）。",
      audience: "总 agent",
      defaultText: "",
      placeholders: [],
      order: 1,
    },
    {
      key: "master.rules_updated",
      plugin: PLUGIN,
      role: "master",
      title: "规则更新通知",
      description: "系统规则（或规划会话的系统提示）变化后，下一条消息开头附带的通知文字。",
      whenSent: "运行中的总 agent / 规划会话已收到旧文本，而当前文本哈希已变化时。",
      audience: "总 agent、规划会话",
      defaultText: "[总 agent 规则已更新：以下规则取代此前所有规则和补充]\n\n{{rules}}",
      placeholders: [{ name: "rules", description: "完整的当前规则（正文 + 补充）" }],
      order: 2,
    },
    {
      key: "master.repair_json",
      plugin: PLUGIN,
      role: "master",
      title: "JSON 修复请求",
      description: "总 agent 或规划会话的回复不符合约定格式时，要求它重新给出正确 JSON 的消息。",
      whenSent: "回复解析失败后（重试次数见总 agent 设置的「高级」分组）。",
      audience: "总 agent、规划会话",
      defaultText:
        "你的回复被拒绝：{{error}}\n请只重新回复修正后的 {{kind}} JSON 对象，放在 ```json 围栏里。",
      placeholders: [
        { name: "error", description: "解析失败的原因" },
        { name: "kind", description: "期望的 JSON 类型，如 task_done、plan" },
      ],
      order: 20,
    },
    {
      key: "master.handoff_summary",
      plugin: PLUGIN,
      role: "handoff",
      title: "总 agent 交接摘要",
      description:
        "更换总 agent 后，新总 agent 首条消息附带的摘要框架；各段内容由插件根据任务快照生成。",
      whenSent: "更换总 agent 预设、更换权限模式等导致新总 agent 启动，并在它收到第一条消息时。",
      audience: "新的总 agent",
      defaultText: `[handoff] 你接替上一任总 agent。以下摘要来自任务快照，不依赖旧会话。解释调度状态时先读取当前状态，不凭旧会话记忆。

## 最近的切换
{{switches}}

## 已完成任务（{{days}} 天确认窗口）
{{done}}`,
      placeholders: [
        { name: "switches", description: "最近的切换记录（每行一条）" },
        { name: "days", description: "「最近」的天数" },
        { name: "done", description: "近期完成的任务" },
      ],
      order: 50,
    },
  ];
}

export type MasterPromptKey =
  | "master.rules"
  | "master.rules_supplement"
  | "master.rules_updated"
  | "master.repair_json"
  | "master.handoff_summary";
