// Pure helpers for the master screen (no React): what the owner can switch to, and how to label it.

import type { MasterSessionRow, MasterTarget, ProviderInfo } from "../shared/rpc";
import { thinkingLabel } from "../shared/vibe/ui/thinking";

export interface SwitchChoice {
  key: string;
  label: string;
  detail: string;
  level: ProviderInfo["level"];
  request: { provider: string; model?: string; thinking?: string };
  active: boolean;
}

export const targetLabel = (t: MasterTarget | null): string =>
  t ? `${t.provider} / ${t.model}${t.thinking ? `（${thinkingLabel({ id: t.thinking })}）` : ""}` : "尚未解析";

export function quotaLabel(p: Pick<ProviderInfo, "remainingPct" | "level">): string {
  if (p.remainingPct === null) return "额度未知";
  return `剩余 ${p.remainingPct}%${p.level === "ok" ? "" : ` - ${LEVEL_LABELS[p.level] ?? p.level}`}`;
}

const LEVEL_LABELS: Record<string, string> = { tight: "紧张", exhausted: "已用完", unknown: "未知" };

export interface ThinkingChip {
  id: string;
  label: string;
}

/**
 * Chips of the "思考档位" setting: "默认" plus the thinking levels of the model the settings pick
 * (an empty model means the master's own default: Claude's Opus, else the provider default).
 * A saved value the model does not list (e.g. the old free-text "max") stays selectable.
 */
export function thinkingChips(
  providers: readonly ProviderInfo[],
  provider: string,
  model: string,
  current: string,
): ThinkingChip[] {
  const models = providers.find((p) => p.id === provider)?.models ?? [];
  const picked =
    models.find((m) => m.id === model) ??
    (model ? undefined : provider === "claude" ? models.find((m) => /opus/i.test(m.id)) : undefined) ??
    (model ? undefined : (models.find((m) => m.isDefault) ?? models[0]));
  const options = picked?.thinking ?? [];
  const chips: ThinkingChip[] = [
    { id: "", label: "默认" },
    ...options.map((o) => ({ id: o.id, label: thinkingLabel(o) })),
  ];
  if (current && !options.some((o) => o.id === current)) {
    chips.push({ id: current, label: `${thinkingLabel({ id: current })}（当前值）` });
  }
  return chips;
}

/**
 * One choice per provider model (default reasoning), plus one "max reasoning" choice for models
 * that offer thinking levels. Claude's Opus and the default models come first.
 */
export function switchChoices(providers: ProviderInfo[], active: MasterTarget | null): SwitchChoice[] {
  const out: SwitchChoice[] = [];
  for (const p of providers) {
    const models = [...p.models].sort(
      (a, b) =>
        Number(/opus/i.test(b.id)) - Number(/opus/i.test(a.id)) ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.id.localeCompare(b.id),
    );
    for (const m of models.slice(0, 3)) {
      const isActive = active?.provider === p.id && active.model === m.id;
      out.push({
        key: `${p.id}:${m.id}`,
        label: `${p.label} / ${m.label}`,
        detail: quotaLabel(p),
        level: p.level,
        request: { provider: p.id, model: m.id },
        active: isActive && !active?.thinking,
      });
      if (m.thinking.length > 1) {
        out.push({
          key: `${p.id}:${m.id}:max`,
          label: `${p.label} / ${m.label} - 最高推理`,
          detail: quotaLabel(p),
          level: p.level,
          request: { provider: p.id, model: m.id, thinking: "max" },
          active: isActive && !!active?.thinking,
        });
      }
    }
  }
  return out;
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
  switched: "切换订阅",
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
