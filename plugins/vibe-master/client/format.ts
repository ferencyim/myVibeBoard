// Pure helpers for the master screen (no React): which presets to offer, and how to label things.

import type { MasterSessionRow, MasterTarget, PresetChoice } from "../shared/rpc";
import { thinkingLabel } from "../shared/vibe/ui/thinking";

export const targetLabel = (t: MasterTarget | null): string =>
  t ? `${t.provider} / ${t.model}${t.thinking ? `（${thinkingLabel({ id: t.thinking })}）` : ""}` : "尚未解析";

export function quotaLabel(p: Pick<PresetChoice, "remainingPct" | "level">): string {
  if (p.remainingPct === null) return "额度未知";
  return `剩余 ${p.remainingPct}%${p.level === "ok" ? "" : ` - ${LEVEL_LABELS[p.level] ?? p.level}`}`;
}

const LEVEL_LABELS: Record<string, string> = { tight: "紧张", exhausted: "已用完", unknown: "未知" };

/** Presets the master can run on, as the card's planner selector filters them (open or tagged planner); the chosen one always stays. */
export function presetChoices(presets: readonly PresetChoice[], selectedId: string): PresetChoice[] {
  return presets.filter((p) => p.id === selectedId || p.roleHints.length === 0 || p.roleHints.includes("planner"));
}

/** One line on the master screen: who decides the dispatch order, and why the scheduler does when the master cannot. */
export function dispatchLabel(d: { enabled: boolean; available: boolean; reason: string }): string {
  if (!d.enabled) return "派发：调度器按规则派发（总 agent 派发已关闭）";
  if (!d.available) return `派发：暂时回落到调度器规则（${d.reason || "总 agent 不可用"}）`;
  return "派发：调度器有空位时由总 agent 选择先开始的待办卡";
}

const STATE_LABELS: Record<string, string> = {
  starting: "启动中",
  working: "工作中",
  waiting: "等待中",
  idle: "空闲",
  error: "出错",
  ended: "已结束",
};

const RETIRED_LABELS: Record<string, string> = {
  switched: "更换预设",
  mode_changed: "权限模式变更",
  replaced: "原会话不可用，已重建",
};

const clock = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** One line per master session: "claude / opus (high)", the period, and why it ended. */
export function sessionTitle(row: MasterSessionRow): string {
  const model = row.model ? ` / ${row.model}${row.thinking ? `（${thinkingLabel({ id: row.thinking })}）` : ""}` : "";
  return `${row.provider}${model}`;
}

export function sessionDetail(row: MasterSessionRow): string {
  const period = row.endedAt ? `${clock(row.startedAt)} 至 ${clock(row.endedAt)}` : `${clock(row.startedAt)} 起`;
  const reason = row.retiredReason ? `，${RETIRED_LABELS[row.retiredReason] ?? row.retiredReason}` : "";
  return `${row.current ? "当前会话" : "历史会话"} - ${STATE_LABELS[row.state] ?? row.state} - ${period}${reason}`;
}

/** Placeholder names written as {{name}} in a template. */
export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!))];
}
